// Strife control adapter; upstream Mumble owns audio, networking and shortcuts.
#include "StrifeBridge.h"
#include "Audio.h"
#include "Cert.h"
#include "Channel.h"
#include "ClientUser.h"
#include "Global.h"
#include "GlobalShortcut.h"
#include "MainWindow.h"
#include "ServerHandler.h"
#include "Settings.h"
#include "JSONSerialization.h"
#include <QApplication>
#include <QDialog>
#include <QDesktopServices>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLocalSocket>
#include <QTimer>
#include <QUrl>
#include <QTextDocument>
#include <QTextBlock>
#include <QTextFragment>
#include <QFile>
#include <QSettings>
#ifdef Q_OS_WIN
#include <qt_windows.h>
#endif

#ifndef USE_RNNOISE
#error Strife requires RNNoise in the native voice engine.
#endif

// QWidget::show(), showNormal(), tray actions and global shortcuts all reach
// this virtual method. Suppress visibility before a native window can appear.
void MainWindow::setVisible(bool visible) {
    QMainWindow::setVisible(visible && qEnvironmentVariableIsEmpty("STRIFE_PIPE"));
}

namespace {
constexpr int MaxFrame = 1024 * 1024;
class StrifeBridge final : public QObject {
    QLocalSocket socket;
    QTimer timer;
    QByteArray pending, previous;
    bool authenticated = false;
    bool dialogOpen = false;

    void foregroundDialog(QWidget *dialog) {
        if (!dialog->isVisible()) return;
#ifdef Q_OS_WIN
        const auto owner = reinterpret_cast<HWND>(qEnvironmentVariable("STRIFE_PARENT_WINDOW").toULongLong());
        DWORD ownerProcess = 0;
        if (owner) GetWindowThreadProcessId(owner, &ownerProcess);
        if (ownerProcess && ownerProcess == qEnvironmentVariable("STRIFE_PARENT_PID").toULong()) {
            HWND parent = owner;
            // Keep nested prompts owned by their dialog, not behind it.
            for (auto *widget = dialog->parentWidget(); widget; widget = widget->parentWidget()) {
                if (widget->isWindow() && widget->isVisible()) {
                    parent = reinterpret_cast<HWND>(widget->winId());
                    break;
                }
            }
            SetWindowLongPtrW(reinterpret_cast<HWND>(dialog->winId()), GWLP_HWNDPARENT,
                              reinterpret_cast<LONG_PTR>(parent));
        }
#endif
        if (dialog->isMinimized()) dialog->showNormal();
        dialog->raise();
        dialog->activateWindow();
#ifdef Q_OS_WIN
        // The host grants foreground permission before sending the command.
        SetForegroundWindow(reinterpret_cast<HWND>(dialog->winId()));
#endif
    }
    bool eventFilter(QObject *object, QEvent *event) override {
        if (event->type() == QEvent::Show) {
            if (auto *dialog = qobject_cast<QDialog *>(object); dialog && dialog->isWindow()) {
                // Run after Qt has finished creating and showing the HWND.
                // Using the dialog as context also cancels this if it closes.
                QTimer::singleShot(0, dialog, [this, dialog]() { foregroundDialog(dialog); });
            }
        }
        return QObject::eventFilter(object, event);
    }

    void send(const QJsonObject &message) {
        if (socket.state() != QLocalSocket::ConnectedState) return;
        if (socket.bytesToWrite() > 4 * MaxFrame) { socket.abort(); return; }
        socket.write(QJsonDocument(message).toJson(QJsonDocument::Compact) + '\n');
    }
    void sendLog() {
        // Mumble hides empty blocks between message frames with zero line height.
        // toPlainText() exposes those separators and discards the link targets.
        QString text;
        QJsonArray links;
        bool firstBlock = true;
        auto *document = Global::get().mw->qteLog->document();
        for (auto block = document->begin(); block.isValid(); block = block.next()) {
            const auto format = block.blockFormat();
            if (block.text().isEmpty() && format.lineHeightType() == QTextBlockFormat::FixedHeight
                && format.lineHeight() == 0) continue;
            if (!firstBlock) text += QLatin1Char('\n');
            firstBlock = false;
            for (auto it = block.begin(); !it.atEnd(); ++it) {
                const auto fragment = it.fragment();
                if (!fragment.isValid()) continue;
                const auto href = fragment.charFormat().anchorHref();
                const auto start = text.size();
                // Match QTextDocument's plain-text whitespace conversion. UTF-16
                // offsets then address the same characters in JavaScript strings.
                text += fragment.text().replace(QChar::LineSeparator, QLatin1Char('\n'))
                    .replace(QChar::ParagraphSeparator, QLatin1Char('\n'))
                    .replace(QChar::Nbsp, QLatin1Char(' '));
                if (!href.isEmpty()) {
                    links.append(QJsonObject{{QStringLiteral("start"), start},
                        {QStringLiteral("length"), text.size() - start}, {QStringLiteral("href"), href}});
                }
            }
        }
        const qsizetype removed = qMax(qsizetype(0), text.size() - 120000);
        QJsonArray retainedLinks;
        for (const auto &value : links) {
            auto link = value.toObject();
            const auto start = link.value(QStringLiteral("start")).toInteger();
            const auto end = start + link.value(QStringLiteral("length")).toInteger();
            if (end <= removed) continue;
            link[QStringLiteral("start")] = qMax(qint64(0), start - removed);
            link[QStringLiteral("length")] = end - qMax(start, qint64(removed));
            retainedLinks.append(link);
        }
        QJsonObject message{{QStringLiteral("type"), QStringLiteral("log")},
            {QStringLiteral("text"), text.mid(removed)}, {QStringLiteral("links"), retainedLinks}};
        // Keep even pathological rich-text logs within the existing IPC bound.
        if (QJsonDocument(message).toJson(QJsonDocument::Compact).size() >= MaxFrame)
            message.remove(QStringLiteral("links"));
        send(message);
    }
    void snapshot() {
        auto &g = Global::get();
        QJsonArray channels, users;
        for (auto *c : Channel::c_qhChannels) {
            channels.append(QJsonObject{{QStringLiteral("id"), static_cast<int>(c->iId)},
                {QStringLiteral("parent"), c->cParent ? static_cast<int>(c->cParent->iId) : -1},
                {QStringLiteral("name"), c->qsName}, {QStringLiteral("position"), c->iPosition}});
        }
        for (auto *u : ClientUser::c_qmUsers) {
            users.append(QJsonObject{{QStringLiteral("id"), static_cast<int>(u->uiSession)},
                {QStringLiteral("channel"), u->cChannel ? static_cast<int>(u->cChannel->iId) : -1},
                {QStringLiteral("name"), u->qsName},
                {QStringLiteral("talking"), u->tsState != Settings::Passive && u->tsState != Settings::MutedTalking},
                {QStringLiteral("muted"), u->bMute || u->bSelfMute || u->bSuppress || u->bLocalMute},
                {QStringLiteral("deafened"), u->bDeaf || u->bSelfDeaf}});
        }
        bool pttBound = false;
        for (const auto &shortcut : g.s.qlShortcuts)
            if (shortcut.iIndex == g.mw->gsPushTalk->idx && !shortcut.qlButtons.isEmpty()) pttBound = true;
        QJsonObject state{{QStringLiteral("type"), QStringLiteral("state")},
            {QStringLiteral("connected"), g.uiSession != 0},
            {QStringLiteral("session"), static_cast<int>(g.uiSession)},
            {QStringLiteral("muted"), g.s.bMute}, {QStringLiteral("deafened"), g.s.bDeaf},
            {QStringLiteral("rnnoise"), g.s.noiseCancelMode == Settings::NoiseCancelRNN || g.s.noiseCancelMode == Settings::NoiseCancelBoth},
            {QStringLiteral("transmitMode"), static_cast<int>(g.s.atTransmit)},
            {QStringLiteral("pttBound"), pttBound},
            {QStringLiteral("channels"), channels}, {QStringLiteral("users"), users}};
        auto bytes = QJsonDocument(state).toJson(QJsonDocument::Compact);
        if (bytes != previous) { previous = bytes; send(state); }
    }
    void command(const QJsonObject &m) {
        auto &g = Global::get();
        const QString op = m.value(QStringLiteral("command")).toString();
        QString error;
        if (op == QStringLiteral("readImportSettings")) {
            try {
                const QString source = m.value(QStringLiteral("source")).toString();
                Settings imported;
                // Upstream Mumble defaults to Speex. Strife's new-profile default
                // must not change a setting omitted by Mumble's sparse serializer.
                imported.noiseCancelMode = Settings::NoiseCancelSpeex;
                if (source == QStringLiteral("registry")) {
                    QSettings registry;
                    if (registry.allKeys().isEmpty()) throw std::runtime_error("No Mumble registry settings found.");
                    imported.legacyLoad(QStringLiteral(":::::REGISTRY:::::"));
                } else {
                    QFile file(source);
                    if (!file.open(QIODevice::ReadOnly) || file.size() > 512 * 1024)
                        throw std::runtime_error("Cannot read settings, or the file exceeds 512 KB.");
                    if (source.endsWith(QStringLiteral(".json"), Qt::CaseInsensitive)) {
                        const auto json = nlohmann::json::parse(file.readAll().toStdString());
                        if (!json.is_object() || !json.contains("settings_version") || json.at("settings_version") != 1)
                            throw std::runtime_error("Unsupported Mumble settings version.");
                        json.get_to(imported);
                    } else {
                        QSettings legacy(source, QSettings::IniFormat);
                        const auto keys = legacy.allKeys();
                        bool recognized = false;
                        for (const auto &key : keys)
                            recognized |= key.startsWith(QStringLiteral("audio/")) || key.startsWith(QStringLiteral("net/"))
                                || key.startsWith(QStringLiteral("ui/")) || key.startsWith(QStringLiteral("shortcuts/"))
                                || key == QStringLiteral("databaselocation");
                        if (!recognized || legacy.status() != QSettings::NoError)
                            throw std::runtime_error("Not a readable Mumble client settings file.");
                        imported.legacyLoad(source);
                    }
                }
                const nlohmann::json normalized = imported;
                const auto settings = QJsonDocument::fromJson(QByteArray::fromStdString(normalized.dump())).object();
                send({{QStringLiteral("type"), QStringLiteral("result")}, {QStringLiteral("id"), m.value(QStringLiteral("id"))},
                    {QStringLiteral("ok"), true}, {QStringLiteral("settings"), settings},
                    {QStringLiteral("hasIdentity"), CertWizard::validateCert(imported.kpCertificate)},
                    {QStringLiteral("databasePath"), imported.qsDatabaseLocation}});
            } catch (const std::exception &) {
                // Parser diagnostics can include certificate bytes or passwords.
                send({{QStringLiteral("type"), QStringLiteral("result")}, {QStringLiteral("id"), m.value(QStringLiteral("id"))},
                    {QStringLiteral("ok"), false}, {QStringLiteral("error"), QStringLiteral("Cannot read Mumble settings. Choose a valid version 1 JSON, legacy INI/conf file, or existing Mumble registry settings (maximum 512 KB).")}});
            }
            return;
        } else if (op == QStringLiteral("connect")) {
            const QUrl url(m.value(QStringLiteral("url")).toString());
            if (url.scheme() != QStringLiteral("mumble") || url.host().isEmpty() || url.userName().isEmpty()
                || url.port(64738) < 1 || url.port(64738) > 65535) error = QStringLiteral("Invalid Mumble server address.");
            else if (g.uiSession || (g.sh && g.sh->isRunning())) error = QStringLiteral("Disconnect before connecting to another server.");
            else g.mw->openUrl(url);
        } else if (op == QStringLiteral("checkImport")) {
            if (dialogOpen || QApplication::activeModalWidget()) error = QStringLiteral("Close Mumble's settings and other native dialogs before importing.");
            else if (g.uiSession || (g.sh && g.sh->isRunning())) error = QStringLiteral("Disconnect from Mumble before importing.");
        } else if (op == QStringLiteral("disconnect")) g.mw->on_qaServerDisconnect_triggered();
        else if (op == QStringLiteral("mute")) g.mw->qaAudioMute->trigger();
        else if (op == QStringLiteral("deafen")) g.mw->qaAudioDeaf->trigger();
        else if (op == QStringLiteral("join")) {
            const int id = m.value(QStringLiteral("channel")).toInt(-1);
            if (!g.uiSession || id < 0 || !Channel::get(static_cast<unsigned int>(id))) error = QStringLiteral("Channel is no longer available.");
            else g.sh->joinChannel(g.uiSession, static_cast<unsigned int>(id));
        } else if (op == QStringLiteral("openLink")) {
            const auto target = m.value(QStringLiteral("url")).toString();
            const QUrl url(target, QUrl::StrictMode);
            // Match Log::allowedSchemes() (protected upstream), excluding native
            // client/channel references. Keep wwwroot/chat.js in sync.
            static const QStringList schemes = {QStringLiteral("mumble"), QStringLiteral("http"),
                QStringLiteral("https"), QStringLiteral("gemini"), QStringLiteral("ftp"),
                QStringLiteral("spotify"), QStringLiteral("steam"), QStringLiteral("irc"),
                QStringLiteral("gg"), QStringLiteral("mailto"), QStringLiteral("xmpp"),
                QStringLiteral("skype"), QStringLiteral("rtmp"), QStringLiteral("magnet")};
            if (target.size() > 8192 || !url.isValid() || url.isRelative()
                || !schemes.contains(url.scheme()))
                error = QStringLiteral("This link address is not supported.");
            else if (!QDesktopServices::openUrl(url)) error = QStringLiteral("Could not open this link.");
        } else if (op == QStringLiteral("chat")) {
            const auto message = m.value(QStringLiteral("text")).toString();
            if (!g.uiSession) error = QStringLiteral("Connect before sending a message.");
            else if (message.trimmed().isEmpty() || message.size() > 5000) error = QStringLiteral("Messages must contain 1 to 5000 characters.");
            else {
                const bool previousSelection = g.s.bChatBarUseSelection;
                g.s.bChatBarUseSelection = false;
                g.mw->sendChatbarText(message, true);
                g.s.bChatBarUseSelection = previousSelection;
            }
        } else if (op == QStringLiteral("settings") || op == QStringLiteral("wizard") || op == QStringLiteral("certificate")) {
            if (!dialogOpen) {
                dialogOpen = true;
                QTimer::singleShot(0, this, [this, op]() {
                    auto *mw = Global::get().mw;
                    if (op == QStringLiteral("settings")) mw->on_qaConfigDialog_triggered();
                    else if (op == QStringLiteral("wizard")) mw->on_qaAudioWizard_triggered();
                    else mw->on_qaConfigCert_triggered();
                    Global::get().s.save();
                    dialogOpen = false;
                });
            } else if (auto *dialog = QApplication::activeModalWidget()) {
                foregroundDialog(dialog);
            }
        } else if (op == QStringLiteral("shutdown")) qApp->quit();
        else error = QStringLiteral("Unknown voice command.");
        send({{QStringLiteral("type"), QStringLiteral("result")},
              {QStringLiteral("id"), m.value(QStringLiteral("id"))},
              {QStringLiteral("ok"), error.isEmpty()}, {QStringLiteral("error"), error}});
        snapshot();
    }
public:
    ~StrifeBridge() override {
        qApp->removeEventFilter(this);
        timer.stop();
        socket.blockSignals(true);
        socket.abort();
    }
    explicit StrifeBridge(QObject *parent) : QObject(parent) {
        qApp->installEventFilter(this);
        // Destroy the adapter while Global and MainWindow are still alive.
        // Qt's application object itself outlives Mumble's global teardown.
        connect(qApp, &QCoreApplication::aboutToQuit, this, [this]() { delete this; });
        connect(&socket, &QLocalSocket::connected, this, [this]() {
            send({{QStringLiteral("type"), QStringLiteral("hello")},
                {QStringLiteral("protocol"), 1}, {QStringLiteral("token"), qEnvironmentVariable("STRIFE_PIPE_TOKEN")}});
        });
        connect(&socket, &QLocalSocket::disconnected, this, []() {
            Global::get().s.bMute = true;
            qApp->quit(); // Capture never outlives the host connection.
        });
        connect(&socket, &QLocalSocket::readyRead, this, [this]() {
            pending += socket.readAll();
            if (pending.size() > MaxFrame) { socket.abort(); return; }
            qsizetype newline;
            while ((newline = pending.indexOf('\n')) >= 0) {
                QJsonParseError error;
                auto doc = QJsonDocument::fromJson(pending.left(newline), &error);
                pending.remove(0, newline + 1);
                if (error.error != QJsonParseError::NoError || !doc.isObject()) { socket.abort(); return; }
                if (!authenticated) {
                    if (doc.object().value(QStringLiteral("command")).toString() != QStringLiteral("hello")) { socket.abort(); return; }
                    authenticated = true;
                    sendLog(); snapshot(); timer.start(100);
                } else command(doc.object());
            }
        });
        connect(&timer, &QTimer::timeout, this, [this]() { snapshot(); });
        connect(Global::get().mw->qteLog->document(), &QTextDocument::contentsChanged, this, [this]() {
            if (authenticated) sendLog();
        });
        socket.connectToServer(qEnvironmentVariable("STRIFE_PIPE"));
        QTimer::singleShot(15000, this, [this]() { if (!authenticated) qApp->quit(); });
    }
};
}
void initializeStrifeSettings() {
    if (qEnvironmentVariableIsEmpty("STRIFE_PIPE")) return;
    auto &s = Global::get().s;
    s.qsDatabaseLocation = qEnvironmentVariable("STRIFE_DATABASE");
    s.bAutoConnect = false;
    s.bUpdateCheck = false;
    s.bPluginCheck = false;
    s.bShowTalkingUI = false;
    s.audioWizardShown = true;
    if (!CertWizard::validateCert(s.kpCertificate)) s.kpCertificate = CertWizard::generateNewCert();
}
void startStrifeBridge() {
    if (!qEnvironmentVariableIsEmpty("STRIFE_PIPE")) new StrifeBridge(qApp);
}
