(function (root) {
  'use strict';
  // The photo strip's DOM (index.html #strip): one tile per photo, redrawn
  // from the list app.js keeps (photos.js). Clicks go back through
  // `handlers`; nothing here changes the list itself.
  function create(el, handlers) {
    const listEl = el.querySelector('#stripList');
    const countEl = el.querySelector('#stripCount');
    const toggleEl = el.querySelector('#stripToggle');
    toggleEl.addEventListener('click', () => handlers.toggle());
    listEl.addEventListener('click', (e) => {
      const t = e.target.closest('.thumb');
      if (!t) return;
      const id = Number(t.dataset.id);
      if (e.target.closest('.rm')) { handlers.remove(id); return; }
      if (e.target.closest('.hdr.set')) { handlers.selectSet(id); return; }
      if (e.shiftKey) handlers.select(id, 'range');
      else if (e.ctrlKey || e.metaKey) handlers.select(id, 'toggle');
      else handlers.open(id);
    });

    // opts: { shown (not collapsed), loadingId (the photo being opened) }.
    function render(list, opts) {
      el.classList.toggle('hidden', list.entries.length < 2);
      el.classList.toggle('collapsed', !opts.shown);
      toggleEl.setAttribute('aria-expanded', String(opts.shown));
      countEl.textContent = list.entries.length ? '(' + list.entries.length + ')' : '';
      const sel = new Set(list.selected().map((e) => e.id));
      const byId = new Map([...listEl.children].map((n) => [Number(n.dataset.id), n]));
      const nodes = list.entries.map((e) => {
        let n = byId.get(e.id);
        if (!n) {
          n = document.createElement('div');
          n.className = 'thumb';
          n.dataset.id = e.id;
          n.setAttribute('role', 'option');
          n.innerHTML = '<span class="name"></span><button class="rm" type="button" aria-label="Remove from the strip">&times;</button>';
        }
        const name = Photos.nameOf(e);
        n.title = e.error ? name + ' — ' + e.error : name;
        n.querySelector('.name').textContent = name;
        // HDR: a member of a bracket set (click: select the set), or a
        // merged photo.
        const hdrText = e.members ? 'HDR' : e.set ? 'HDR ' + e.set.length : '';
        let hdr = n.querySelector('.hdr');
        if (hdrText && !hdr) { hdr = document.createElement('span'); hdr.className = 'hdr'; n.appendChild(hdr); }
        if (hdr && !hdrText) hdr.remove();
        if (hdrText) {
          hdr.textContent = hdrText;
          hdr.classList.toggle('set', !!e.set);
          hdr.title = e.set ? 'One of ' + e.set.length + ' bracketed exposures: click to select them all' : 'Merged HDR photo';
        }
        const bg = e.thumb ? 'url("' + e.thumb + '")' : '';
        if (n.style.backgroundImage !== bg) n.style.backgroundImage = bg;
        n.classList.toggle('current', e.id === list.currentId);
        n.classList.toggle('selected', sel.has(e.id) && e.id !== list.currentId);
        n.classList.toggle('error', !!e.error);
        n.classList.toggle('loading', e.id === opts.loadingId);
        n.setAttribute('aria-selected', String(sel.has(e.id)));
        let dot = n.querySelector('.dot');
        if (e.edited && !dot) { dot = document.createElement('span'); dot.className = 'dot'; n.appendChild(dot); }
        if (!e.edited && dot) dot.remove();
        return n;
      });
      // Only touch the children when the order or set changed, so hovering
      // a tile (its remove button) survives a redraw.
      const same = nodes.length === listEl.children.length && nodes.every((n, i) => listEl.children[i] === n);
      if (!same) listEl.replaceChildren(...nodes);
      const cur = listEl.querySelector('.current');
      if (cur && opts.scroll) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    return { render };
  }
  root.Strip = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
