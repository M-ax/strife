export function createDownloads({request, notice}) {
  const list = document.getElementById('download-list');
  const summary = document.createElement('span');
  summary.className = 'download-summary'; summary.setAttribute('role', 'status');
  document.querySelector('[data-panel="downloads"] .panel-header').append(summary);
  const act = (command, data) => request(command, data).catch(error => notice(error.message));
  document.getElementById('downloads-folder').onclick = () => act('downloadsFolder');
  document.getElementById('downloads-clear').onclick = () => act('downloadsClear');
  const rows = new Map();
  const bytes = value => value < 1024 ? value + ' B' : value < 1048576 ? (value / 1024).toFixed(1) + ' KB' : (value / 1048576).toFixed(1) + ' MB';
  return {
    receive(message) {
      const items = message.items || [];
      document.getElementById('download-empty').hidden = items.length > 0;
      document.getElementById('download-directory').textContent = message.directory;
      document.getElementById('downloads-clear').disabled = !items.some(item => item.state !== 'downloading');
      const active = items.filter(item => item.state === 'downloading').length;
      summary.textContent = active ? active + ' downloading' : items.length ? items.length + ' downloads' : '';
      for (const [id, row] of rows) if (!items.some(item => item.id === id)) { row.element.remove(); rows.delete(id); }
      for (const item of items) {
        let row = rows.get(item.id);
        if (!row) {
          const element = document.createElement('li');
          const name = document.createElement('strong'), status = document.createElement('span');
          const progress = document.createElement('progress'), cancel = document.createElement('button');
          cancel.textContent = 'Cancel'; cancel.onclick = () => act('downloadCancel', {downloadId: item.id});
          element.append(name, status, progress, cancel); list.prepend(element);
          row = {element, name, status, progress, cancel}; rows.set(item.id, row);
        }
        row.name.textContent = item.name;
        row.cancel.setAttribute('aria-label', 'Cancel ' + item.name);
        row.cancel.hidden = item.state !== 'downloading';
        row.progress.hidden = item.state !== 'downloading';
        row.progress.setAttribute('aria-label', 'Download progress for ' + item.name);
        if (item.total > 0) { row.progress.max = item.total; row.progress.value = item.bytes; }
        else row.progress.removeAttribute('value');
        const state = {downloading: 'Downloading', completed: 'Completed', cancelled: 'Cancelled', failed: 'Failed'}[item.state] || item.state;
        row.status.textContent = state + ' · ' + bytes(item.bytes) + (item.total > 0 ? ' / ' + bytes(item.total) : '') + (item.error ? ' · ' + item.error : '');
      }
    }
  };
}
