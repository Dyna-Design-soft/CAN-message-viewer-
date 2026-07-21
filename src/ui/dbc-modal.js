// DBC manager tab: load/unload DBC files, browse cluster -> frames -> signals.

import { parseDbc } from '../core/dbc-parser.js';
import { formatId } from '../util/hex.js';

export function initDbcModal(app) {
  const tree = document.getElementById('dbc-tree');
  const fileInput = document.getElementById('dbc-file-input');

  document.getElementById('dbc-load').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    for (const file of fileInput.files) {
      const text = await file.text();
      const cluster = parseDbc(text, file.name);
      cluster.source = text; // kept so the DBC can be persisted across reloads
      app.dbc.add(cluster);
    }
    fileInput.value = '';
    app.bus.emit('dbc:changed', { clusters: app.dbc.clusters });
    render();
  });

  // keep the tab in sync whether DBCs change here or via demo auto-load
  app.bus.on('dbc:changed', render);

  function render() {
    tree.textContent = '';
    if (app.dbc.clusters.length === 0) {
      tree.innerHTML = '<p class="placeholder">No DBC files loaded yet.</p>';
      return;
    }
    for (const cluster of app.dbc.clusters) {
      tree.appendChild(renderCluster(cluster));
    }
  }

  function renderCluster(cluster) {
    const det = el('details', 'tree-node dbc-cluster');
    det.open = app.dbc.clusters.length === 1;
    const sum = el('summary');
    const msgCount = cluster.messages.size;
    const sigCount = [...cluster.messages.values()].reduce((a, m) => a + m.signals.length, 0);
    sum.append(
      text(`${cluster.name}`),
      el('span', 'cluster-meta', ` ${cluster.fileName} — ${msgCount} frames, ${sigCount} signals` +
        (cluster.nodes.length ? `, nodes: ${cluster.nodes.join(', ')}` : '')),
    );
    const remove = el('button', 'btn dbc-remove', 'Unload');
    remove.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      app.dbc.remove(cluster.name);
      app.bus.emit('dbc:changed', { clusters: app.dbc.clusters });
      render();
    });
    sum.appendChild(remove);
    det.appendChild(sum);

    if (cluster.parseErrors.length) {
      const errBox = el('div', 'dbc-errors');
      errBox.textContent = cluster.parseErrors
        .slice(0, 20)
        .map((e) => `line ${e.line}: ${e.text}`)
        .join('\n') + (cluster.parseErrors.length > 20 ? `\n… ${cluster.parseErrors.length - 20} more` : '');
      det.appendChild(errBox);
    }

    const children = el('div', 'tree-children');
    const messages = [...cluster.messages.values()].sort((a, b) => a.id - b.id);
    for (const msg of messages) children.appendChild(renderMessage(msg));
    det.appendChild(children);
    return det;
  }

  function renderMessage(msg) {
    const det = el('details', 'tree-node dbc-msg');
    const sum = el('summary');
    sum.append(
      el('span', 'msg-id', formatId(msg.id, msg.extended)),
      text(` ${msg.name} `),
      el('span', 'msg-meta',
        `DLC ${msg.dlc}${msg.extended ? ', extended' : ''}` +
        (msg.transmitter ? `, tx: ${msg.transmitter}` : '') +
        ` — ${msg.signals.length} signal${msg.signals.length === 1 ? '' : 's'}`),
    );
    det.appendChild(sum);
    if (msg.comment) det.appendChild(el('div', 'dbc-errors muted', msg.comment));

    const table = el('table', 'signal-detail-table');
    table.innerHTML = `<thead><tr>
      <th>Signal</th><th>Start bit</th><th>Length</th><th>Byte order</th><th>Type</th>
      <th>Factor</th><th>Offset</th><th>Min</th><th>Max</th><th>Default</th><th>Unit</th>
      <th>Mux</th><th>Values</th><th>Receivers</th><th>Comment</th>
    </tr></thead>`;
    const tbody = el('tbody');
    for (const s of msg.signals) {
      const tr = el('tr');
      const type = s.isFloat ? (s.isDouble ? 'double' : 'float') : s.signed ? 'signed' : 'unsigned';
      const mux = s.muxRole === 'multiplexor' ? 'M' : s.muxRole === 'multiplexed' ? `m${s.muxValue}` : '';
      const values = s.valueTable
        ? [...s.valueTable.entries()].map(([k, v]) => `${k}=${v}`).join(', ')
        : '';
      appendCells(tr, [
        s.name,
        num(s.startBit), num(s.bitLength),
        s.byteOrder === 1 ? 'Intel' : 'Motorola',
        type,
        num(s.factor), num(s.offset), num(s.min), num(s.max),
        s.defaultValue == null ? '—' : num(s.defaultValue),
        s.unit || '—',
        mux || '—',
        values,
        s.receivers.join(', ') || '—',
        s.comment || '',
      ]);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    det.appendChild(table);
    return det;
  }
}

function el(tag, className = '', textContent = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent) node.textContent = textContent;
  return node;
}

function text(s) {
  return document.createTextNode(s);
}

function num(v) {
  if (typeof v !== 'number') return String(v);
  return Number.isInteger(v) ? String(v) : String(+v.toPrecision(10));
}

function appendCells(tr, values) {
  for (const v of values) {
    const td = document.createElement('td');
    if (typeof v === 'object' && v?.num) {
      td.className = 'num';
      td.textContent = v.text;
    } else {
      td.textContent = String(v);
    }
    tr.appendChild(td);
  }
}
