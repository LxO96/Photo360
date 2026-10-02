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
      // Shooting groups (photos.js groupsOf): where each photo sits in its
      // group, and what varies inside the group.
      const place = new Map();
      for (const g of Photos.groupsOf(list.entries)) {
        const info = Object.assign({ size: g.length, title: groupTitle(g) }, Photos.groupInfo(g));
        g.forEach((e, i) => place.set(e.id, Object.assign({ first: i === 0, last: i === g.length - 1 }, info)));
      }
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
        // Exposure: shutter and ISO, the parts that vary within the group
        // in the accent colour, and the offset from its darkest shot.
        const gp = place.get(e.id) || { size: 1, first: true, last: true };
        let exp = n.querySelector('.exp');
        const s = e.shot;
        if (s && s.exposureTime > 0) {
          if (!exp) { exp = document.createElement('span'); exp.className = 'exp'; n.appendChild(exp); }
          const parts = Photos.exposureLabel(s).split(' · ');
          const spans = [mk(parts[0], gp.shutter)];
          if (parts[1]) spans.push(document.createTextNode(' · '), mk(parts[1], gp.iso));
          if (gp.darkest !== null && gp.darkest !== undefined && Number.isFinite(s.ev)) {
            const d = s.ev - gp.darkest;
            spans.push(document.createTextNode(' · '), mk((d > 0.05 ? '+' : '±') + (d > 0.05 ? d.toFixed(1) : '0') + ' EV', true));
          }
          exp.replaceChildren(...spans);
        } else if (exp) exp.remove();
        n.classList.toggle('grouped', gp.size > 1);
        n.classList.toggle('g-first', gp.size > 1 && gp.first);
        n.classList.toggle('g-last', gp.size > 1 && gp.last);
        n.classList.toggle('gap', gp.first);
        if (gp.size > 1) n.title += '\n' + gp.title;
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

  function mk(text, accent) {
    const s = document.createElement('span');
    s.textContent = text;
    if (accent) s.className = 'diff';
    return s;
  }

  // "3 photos · 17:37:35–17:37:40" (camera-local time).
  function groupTitle(g) {
    const ts = g.map((e) => e.shot && e.shot.time).filter(Number.isFinite);
    const clock = (t) => new Date(t * 1000).toISOString().slice(11, 19);
    const span = ts.length ? ' · ' + clock(Math.min(...ts)) + (ts.length > 1 ? '–' + clock(Math.max(...ts)) : '') : '';
    return g.length + ' photos' + span;
  }
  root.Strip = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
