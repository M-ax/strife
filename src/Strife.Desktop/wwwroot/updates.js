export function updatePresentation(message) {
  const value = message?.value || {};
  const ready = message?.available && value.state === 'ready';
  const downloading = message?.available && value.state === 'downloading';
  const progress = Math.min(100, Math.max(0, Math.trunc(Number(value.progress) || 0)));
  return {
    hidden: !ready && !downloading,
    disabled: !ready,
    label: downloading ? `Update ${progress}%` : 'Update',
    title: ready ? `Install ${value.version} and restart now. Otherwise, installs when you quit.`
      : 'Downloading quietly. You can keep using Strife.',
    status: !message?.available ? 'Automatic updates require a Windows installed build.'
      : value.error || (ready ? `Version ${value.version} will install when you quit.`
        : downloading ? `Downloading ${value.version}: ${progress}%`
        : value.state === 'current' ? 'Strife is up to date.' : 'Updates are checked automatically.')
  };
}

export function createUpdates(request) {
  const button = document.getElementById('update-button');
  const status = document.getElementById('update-status');
  button.onclick = async () => {
    button.disabled = true;
    try { await request('updateInstall'); }
    catch (error) { status.textContent = error.message; button.disabled = false; }
  };
  return {
    receive(message) {
      const view = updatePresentation(message);
      button.hidden = view.hidden; button.disabled = view.disabled;
      button.textContent = view.label; button.title = view.title;
      button.setAttribute('aria-label', `${view.label}. ${view.title}`);
      status.textContent = view.status;
    }
  };
}
