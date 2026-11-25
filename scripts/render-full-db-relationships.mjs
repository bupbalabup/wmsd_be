const groups = [
  'Truy cập và quản trị',
  'Phê duyệt, nhật ký và hỗ trợ kho',
  'Tồn kho và kiểm soát',
  'Kiểm kê, sản phẩm và quy đổi',
  'Điều chỉnh, nguồn ngoài và đơn bán',
  'Bán hàng, trả hàng và giữ hộ',
  'Mua, nhập và hàng giao thất bại',
  'Điều chuyển liên kho',
  'Chỉ khai báo trong biến thể dòng dùng chung',
];

export function renderFullRelationships(layout, cards, references, table, xml) {
  const nodes = new Map(layout.flatMap((row, r) => row.map((name, c) =>
    [name, { ...cards.get(name), row: r, column: c, name }])));
  const pairs = new Map();
  for (const ref of references) {
    if (!nodes.has(ref.target)) continue;
    const key = `${ref.target}|${ref.collection}`;
    if (!pairs.has(key)) {
      pairs.set(key, { from: nodes.get(ref.target), to: nodes.get(ref.collection), fields: [] });
    }
    pairs.get(key).fields.push(ref);
  }

  const edges = [...pairs.values()];
  const ports = new Map();
  const horizontal = new Map();
  const vertical = new Map();
  const rowWraps = new Map();

  function attach(edge, endpoint, side, other) {
    const node = edge[endpoint];
    const key = `${node.name}|${side}`;
    if (!ports.has(key)) ports.set(key, []);
    ports.get(key).push({ edge, endpoint, side, order: side === 'left' || side === 'right' ? other.row : other.column });
  }

  function lane(channels, channel, a, b) {
    const low = Math.min(a, b) - 0.015;
    const high = Math.max(a, b) + 0.015;
    if (!channels.has(channel)) channels.set(channel, []);
    const tracks = channels.get(channel);
    const free = tracks.findIndex(track => track.every(([start, end]) => high < start || low > end));
    const index = free < 0 ? tracks.length : free;
    (tracks[index] ??= []).push([low, high]);
    return { channel, index };
  }

  for (const edge of edges) {
    const { from, to } = edge;
    if (from === to) {
      attach(edge, 'from', 'right', to);
      attach(edge, 'to', 'right', from);
    } else if (from.row === to.row && Math.abs(from.column - to.column) === 1) {
      attach(edge, 'from', from.column < to.column ? 'right' : 'left', to);
      attach(edge, 'to', from.column < to.column ? 'left' : 'right', from);
    } else {
      let sameSide;
      if (from.row === to.row) {
        const count = rowWraps.get(from.row) ?? 0;
        sameSide = count % 2 === 0 ? 'top' : 'bottom';
        rowWraps.set(from.row, count + 1);
      }
      attach(edge, 'from', sameSide ?? (from.row > to.row ? 'top' : 'bottom'), to);
      attach(edge, 'to', sameSide ?? (from.row < to.row ? 'top' : 'bottom'), from);
    }
  }

  for (const entries of ports.values()) {
    entries.sort((a, b) => a.order - b.order);
    for (const [i, { edge, endpoint, side }] of entries.entries()) {
      const ratio = (i + 1) / (entries.length + 1);
      // Offset bottom ports so aligned cards in adjacent rows do not share a stem.
      const port = side === 'top' ? [ratio, 0] : side === 'bottom' ? [ratio + 0.75 / edge[endpoint].width, 1] :
        side === 'left' ? [0, ratio] : [1, ratio];
      edge[`${endpoint}Port`] = { side, point: port.map(value => Number(value.toFixed(5))) };
    }
  }

  for (const edge of edges) {
    const { from, to, fromPort, toPort } = edge;
    if (fromPort.side === 'left' || fromPort.side === 'right') {
      const column = Math.min(from.column, to.column);
      edge.vertical = lane(vertical, column, from.row + 0.05, from.row + 0.95);
    } else {
      edge.firstRow = from.row - Number(fromPort.side === 'top');
      edge.lastRow = to.row - Number(toPort.side === 'top');
      if (edge.firstRow !== edge.lastRow) {
        const column = Math.floor((from.column + to.column) / 2);
        edge.vertical = lane(vertical, column, edge.firstRow + 0.96, edge.lastRow + 0.96);
      }
    }
  }

  const space = tracks => Math.max(60, 32 + (tracks?.length ?? 0) * 5);
  const columnEnds = [];
  let x = 30;
  for (let col = 0; col < Math.max(...layout.map(row => row.length)); col++) {
    const column = [...nodes.values()].filter(node => node.column === col);
    const width = Math.max(...column.map(node => node.width));
    for (const node of column) node.x = x + Math.floor((width - node.width) / 2);
    columnEnds.push(x + width);
    x += width + space(vertical.get(col));
  }

  const laneX = ({ channel, index }) => columnEnds[channel] + 16 + 5 * index;
  const xAt = (node, port) => node.x + node.width * port.point[0];
  for (const edge of edges) {
    const { firstRow, lastRow, vertical, from, to, fromPort, toPort } = edge;
    if (firstRow === undefined) continue;
    const sx = xAt(from, fromPort), tx = xAt(to, toPort);
    edge.first = lane(horizontal, firstRow, sx, vertical ? laneX(vertical) : tx);
    if (vertical) edge.last = lane(horizontal, lastRow, laneX(vertical), tx);
  }
  const rowEnds = new Map([[-1, 24]]);
  let y = 24 + space(horizontal.get(-1));
  for (const [row, names] of layout.entries()) {
    const rowNodes = names.map(name => nodes.get(name));
    for (const node of rowNodes) node.y = y;
    y += Math.max(...rowNodes.map(node => node.height));
    rowEnds.set(row, y);
    y += space(horizontal.get(row));
  }

  const laneY = ({ channel, index }) => rowEnds.get(channel) + 16 + 5 * index;
  const terminal = (node, port) => [xAt(node, port), node.y + node.height * port.point[1]];

  const layerFor = edge => edge.fields.every(ref => ref.sharedVariant) ? groups.length - 1 : edge.to.row;
  const layers = groups.map((name, index) => {
    const count = edges.filter(edge => layerFor(edge) === index).length;
    return `<mxCell id="links_${index}" parent="0" value="${xml(`${name} (${count})`)}"/>`;
  });
  const connectors = edges.map((edge, index) => {
    const { from, to, fields, fromPort, toPort, first, last, vertical } = edge;
    const [sx, sy] = terminal(from, fromPort), [tx, ty] = terminal(to, toPort);
    const bends = last ? [[sx, laneY(first)], [laneX(vertical), laneY(first)],
      [laneX(vertical), laneY(last)], [tx, laneY(last)]] : first ? [[sx, laneY(first)], [tx, laneY(first)]] :
      [[laneX(vertical), sy], [laneX(vertical), ty]];
    const refs = fields.map(ref => `${ref.path} · ${ref.kind}${ref.sharedVariant ? ' (biến thể dùng chung)' : ''}`);
    const tooltip = `<b>${from.name} → ${to.name}</b><br/>${refs.map(xml).join('<br/>')}`;
    const points = bends.map(([x, y]) => `<mxPoint x="${x}" y="${y}"/>`).join('');
    const [exitX, exitY] = fromPort.point;
    const [entryX, entryY] = toPort.point;
    const style = 'noEdgeStyle=1;rounded=0;html=1;strokeColor=#62778E;strokeWidth=1;endArrow=open;endFill=0;endSize=5;' +
      `exitX=${exitX};exitY=${exitY};entryX=${entryX};entryY=${entryY};exitPerimeter=0;entryPerimeter=0;`;
    return `<object id="full_${index}" label="" tooltip="${xml(tooltip)}"><mxCell style="${style}" edge="1" parent="links_${layerFor(edge)}" source="t_${from.name}" target="t_${to.name}"><mxGeometry relative="1" as="geometry"><Array as="points">${points}</Array></mxGeometry></mxCell></object>`;
  });

  const cells = ['<mxCell id="0"/>', ...layers, '<mxCell id="1" parent="0" value="Collections"/>',
    ...connectors, ...[...nodes].flatMap(([name, card]) => table(name, card))];
  const model = `<mxGraphModel grid="1" gridSize="10" page="0" background="#FFFFFF"><root>\n${cells.join('\n')}\n</root></mxGraphModel>`;
  const diagram = `<mxfile host="drawio" agent="WMSD full relationship generator">\n<diagram id="all-relations" name="Toàn bộ quan hệ">\n${model}\n</diagram>\n</mxfile>\n`;
  return { diagram, edgeCount: edges.length, fieldCount: edges.reduce((count, edge) => count + edge.fields.length, 0) };
}
