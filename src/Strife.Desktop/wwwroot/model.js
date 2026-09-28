export function organizeChannels(channels, users, query = '') {
  const byId = new Map(channels.map(c => [c.id, { ...c, children: [], users: [] }]));
  const roots = [];
  for (const channel of byId.values()) {
    const ancestors = new Set([channel.id]);
    let parent = byId.get(channel.parent), cursor = parent, cycle = false;
    while (cursor) {
      if (ancestors.has(cursor.id)) { cycle = true; break; }
      ancestors.add(cursor.id); cursor = byId.get(cursor.parent);
    }
    if (parent && !cycle) parent.children.push(channel); else roots.push(channel);
  }
  for (const user of users) byId.get(user.channel)?.users.push(user);
  const term = query.trim().toLocaleLowerCase();
  function sortAndFilter(nodes) {
    return nodes.sort((a,b) => a.position - b.position || a.name.localeCompare(b.name)).filter(node => {
      node.children = sortAndFilter(node.children);
      node.users.sort((a,b) => a.name.localeCompare(b.name));
      node.populated = node.users.length > 0 || node.children.some(child => child.populated);
      return !term || node.name.toLocaleLowerCase().includes(term) || node.children.length > 0 ||
        node.users.some(u => u.name.toLocaleLowerCase().includes(term));
    });
  }
  return sortAndFilter(roots);
}

export function validateVideoUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Enter an HTTP or HTTPS Helltube URL without embedded credentials.');
  return url.href;
}
