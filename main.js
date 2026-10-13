/* Godot UI Exporter 1.0 — native Figma Plugin API. No MCP or network. */
figma.showUI(__html__, { width: 1080, height: 760, themeColors: true });
const META = 'godot_ui_exporter_v1';
const MAX_NODES = 5000;
let rootId = null, generation = 0, busy = false, cancelled = false, pinned = false, ignoreNextSelectionChange = false;
const post = (type, data) => figma.ui.postMessage(Object.assign({ type }, data || {}));
const num = n => Number.isFinite(n) ? n : 0;
const clone = v => JSON.parse(JSON.stringify(v));
const paints = n => 'fills' in n && Array.isArray(n.fills) ? n.fills.filter(p => p.visible !== false) : [];
const strokes = n => 'strokes' in n && Array.isArray(n.strokes) ? n.strokes.filter(p => p.visible !== false) : [];
function slug(s) { return String(s).normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase().slice(0, 64); }
function key(n) { return 'n_' + n.id.replace(/[^a-zA-Z0-9]/g, '_'); }
function getMeta(n) { try { return JSON.parse(n.getPluginData(META) || '{}'); } catch (_) { return {}; } }
function bounds(n) { return n.absoluteBoundingBox ? clone(n.absoluteBoundingBox) : { x: 0, y: 0, width: num(n.width), height: num(n.height) }; }
function transformed(n) {
  const t = n.absoluteTransform;
  return t && (Math.abs(t[0][0] - 1) > 0.0001 || Math.abs(t[1][1] - 1) > 0.0001 || Math.abs(t[0][1]) > 0.0001 || Math.abs(t[1][0]) > 0.0001);
}
function recommendation(n) {
  const f = paints(n), s = strokes(n);
  const children = 'children' in n ? n.children : [];
  if (n.visible === false) return { mode: 'skip', reason: '숨김 레이어' };
  if (n.exportSettings && n.exportSettings.length) return {
    mode: n.exportSettings[0].format === 'SVG' ? 'svg' : 'png',
    reason: 'Figma Export 지정 요소: 자식 전체를 포함해 합성 추출'
  };
  if (n.isMask) return { mode: 'png', reason: '마스크: 부모 단위 추출 권장' };
  if (children.some(c => c.isMask)) return { mode: 'png', reason: '마스크 합성 결과를 보존' };
  if (transformed(n)) return { mode: 'png', reason: '회전·스케일·반전 결과를 이미지로 보존' };
  if ('effects' in n && n.effects.some(e => e.visible !== false)) return { mode: 'png', reason: '그림자·블러 등 효과 포함' };
  if (n.blendMode && !['NORMAL', 'PASS_THROUGH'].includes(n.blendMode)) return { mode: 'png', reason: '혼합 모드: 배경과 합성 확인 필요' };
  if (children.length && n.opacity < 1) return { mode: 'png', reason: '그룹 불투명도 합성 보존' };
  if (children.length && n.clipsContent) return { mode: 'png', reason: '클리핑 경계를 포함해 추출' };
  if (f.some(p => p.type !== 'SOLID') || f.length > 1 || s.length > 1 || s.some(p => p.type !== 'SOLID')) return { mode: 'png', reason: '이미지·그라데이션·복합 채우기' };
  if (n.type === 'TEXT') return { mode: 'native', reason: 'Godot Label — 글자 수정 가능, 폰트 별도 적용' };
  if (['RECTANGLE', 'FRAME', 'COMPONENT', 'INSTANCE', 'GROUP', 'SECTION', 'COMPONENT_SET'].includes(n.type)) {
    if (s.length && (n.strokeAlign !== 'INSIDE' || (n.dashPattern && n.dashPattern.length))) return { mode: 'png', reason: '외곽·중앙·점선 스트로크 보존' };
    return { mode: 'native', reason: children.length ? '구조·위치 JSON / 단색 배경은 Panel' : '단색 패널은 Godot StyleBoxFlat' };
  }
  return { mode: 'png', reason: '벡터·아이콘·기타 그래픽' };
}
function suggestedName(n) {
  return slug(n.name);
}
function textData(n) {
  if (n.type !== 'TEXT') return null;
  const segments = n.getStyledTextSegments(['fontName', 'fontSize', 'fills', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration']);
  return { characters: n.characters, horizontal_alignment: n.textAlignHorizontal, vertical_alignment: n.textAlignVertical,
    auto_resize: n.textAutoResize, segments: clone(segments) };
}
function style(n) {
  return { fills: clone(paints(n)), strokes: clone(strokes(n)), stroke_weight: typeof n.strokeWeight === 'number' ? n.strokeWeight : 0,
    stroke_sides: ['strokeLeftWeight', 'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight'].map(k => typeof n[k] === 'number' ? n[k] : num(n.strokeWeight)),
    corners: ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius'].map(k => typeof n[k] === 'number' ? n[k] : typeof n.cornerRadius === 'number' ? n.cornerRadius : 0),
    opacity: typeof n.opacity === 'number' ? n.opacity : 1,
    blend_mode: n.blendMode || 'NORMAL', effects: 'effects' in n ? clone(n.effects) : [] };
}
async function inspect(root) {
  const rows = [], componentCount = new Map(), imageCount = new Map();
  const walk = async (n, parent, depth, hidden, ancestorOpacity) => {
    if (rows.length >= MAX_NODES) throw new Error('5,000개 이하로 나누어 선택해 주세요.');
    const b = bounds(n), rec = recommendation(n), meta = getMeta(n);
    let componentId = null, componentWarning = null;
    if (n.type === 'INSTANCE') {
      try { const c = await n.getMainComponentAsync(); componentId = c ? c.key || c.id : null; }
      catch (_) { componentWarning = '원본 컴포넌트를 읽지 못해 공통 여부를 자동 확인하지 못했습니다.'; }
    }
    if (n.type === 'COMPONENT') componentId = n.key || n.id;
    if (componentId) componentCount.set(componentId, (componentCount.get(componentId) || 0) + 1);
    const images = paints(n).filter(p => p.type === 'IMAGE').map(p => p.imageHash);
    images.forEach(h => imageCount.set(h, (imageCount.get(h) || 0) + 1));
    const hiddenNow = hidden || n.visible === false;
    // Selected containers are exported as a complete composition.
    if (n === root && !hiddenNow && 'children' in n && n.children.length && !n.exportSettings?.length) {
      rec.mode = 'png'; rec.reason = '선택한 부모: 자식 전체를 포함해 합성 추출';
    }
    const row = { id: n.id, parent_id: parent, resource_id: key(n), original_name: n.name, type: n.type, depth,
      hidden: hiddenNow, name: suggestedName(n), scope: meta.scope === 'shared' ? 'shared' : 'screen',
      mode: ['native','png','svg','skip'].includes(meta.mode) ? meta.mode : rec.mode,
      reason: rec.reason, bounds: b, render_bounds: n.absoluteRenderBounds ? clone(n.absoluteRenderBounds) : null,
      local_size: { width: num(n.width), height: num(n.height) }, relative_transform: n.relativeTransform ? clone(n.relativeTransform) : null,
      layout: { mode: n.layoutMode || 'NONE', constraints: n.constraints ? clone(n.constraints) : null,
        padding: [num(n.paddingLeft),num(n.paddingTop),num(n.paddingRight),num(n.paddingBottom)], gap: num(n.itemSpacing),
        horizontal_sizing: n.layoutSizingHorizontal || null, vertical_sizing: n.layoutSizingVertical || null, clips_content: !!n.clipsContent },
      style: style(n), text: textData(n), component_key: componentId, image_hashes: images,
      ancestor_opacity: ancestorOpacity, warnings: componentWarning ? [componentWarning] : [] };
    if (row.text) row.warnings.push('폰트 파일은 별도 준비. 줄바꿈·자간·혼합 스타일은 Godot에서 확인');
    if (rec.mode === 'png' && row.mode === 'native') row.warnings.push('복잡한 효과를 native로 지정함: Godot 씬에서 외형 차이 가능');
    if (row.style.effects.some(e => e.visible !== false)) row.warnings.push('고정 경계 추출: 경계 밖 그림자/블러는 잘릴 수 있음. 여백 프레임을 만들어 선택하세요.');
    if (!['NORMAL','PASS_THROUGH'].includes(row.style.blend_mode)) row.warnings.push('배경 의존 혼합 모드: 배경과 함께 부모를 PNG로 추출 권장');
    if (n.isMask) row.warnings.push('마스크만 추출하지 말고 마스크를 포함한 부모를 PNG로 지정하세요.');
    rows.push(row);
    if ('children' in n) for (const child of n.children) await walk(child, n.id, depth + 1, hiddenNow, ancestorOpacity * row.style.opacity);
  };
  await walk(root, null, 0, false, 1);
  rows.forEach(r => { r.shared_candidate = !!r.component_key && (componentCount.get(r.component_key) > 1 || r.type === 'COMPONENT');
    r.reused_image = r.image_hashes.some(h => imageCount.get(h) > 1); });
  return rows;
}
async function scan(usePinned) {
  if (busy) return;
  const token = ++generation;
  const selection = figma.currentPage.selection;
  const root = usePinned && rootId ? await figma.getNodeByIdAsync(rootId) : selection.length === 1 ? selection[0] : null;
  if (!root || !('exportAsync' in root) || root.type === 'SLICE') { rootId = null; post('empty', { message: '화면 Frame 또는 리소스가 든 레이어 하나를 선택하세요.' }); return; }
  post('loading');
  try {
    const rows = await inspect(root);
    if (token !== generation || busy) return;
    rootId = root.id;
    post('scan', { root: { id: root.id, name: root.name, bounds: bounds(root) }, rows });
  } catch (e) { if (token === generation) post('error', { message: e.message }); }
}
function validateConfig(rows, configs, includeInactiveNames = false) {
  const ids = new Map(rows.map(r => [r.id, r]));
  if (!Array.isArray(configs) || configs.length > MAX_NODES) throw new Error('잘못된 설정입니다.');
  const seen = new Set();
  configs.forEach(c => {
    if (!ids.has(c.id) || seen.has(c.id)) throw new Error('대상 레이어가 바뀌었습니다. 다시 분석하세요.');
    seen.add(c.id);
    if (!['native','png','svg','skip'].includes(c.mode) || !['shared','screen'].includes(c.scope)) throw new Error('잘못된 추출 설정입니다.');
    Object.assign(ids.get(c.id), { name: c.name, mode: c.mode, scope: c.scope });
  });
  const blocked = new Set(), paths = new Set();
  rows.forEach(r => {
    r.suppressed = r.hidden || blocked.has(r.parent_id);
    r.duplicate_of = null;
    r.asset_name = r.name;
    if (r.suppressed || ['png','svg','skip'].includes(r.mode)) blocked.add(r.id);
    if ((includeInactiveNames || (!r.suppressed && r.mode !== 'skip')) && !/^[a-z0-9][a-z0-9_]{0,95}$/.test(r.name)) {
      const entered = String(r.name ?? '').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
      const error = new Error(
        '리소스 이름이 올바르지 않습니다: "' + entered + '"\n' +
        '원본 레이어: "' + r.original_name + '" (노드 ID: ' + r.id + ')\n' +
        '영문 소문자 또는 숫자로 시작하고 소문자·숫자·밑줄만 사용하세요 (최대 96자).'
      );
      error.nodeId = r.id;
      throw error;
    }
    // Equal labels do not imply equal visual content. Keep every asset and
    // disambiguate only its destination filename when paths collide.
    if (!r.suppressed && ['png','svg'].includes(r.mode)) {
      let p = r.scope + '/' + r.asset_name + '.' + r.mode;
      if (paths.has(p)) {
        const suffix = r.resource_id.replace(/[^a-zA-Z0-9_]/g, '_');
        r.asset_name = r.name + '_' + suffix;
        p = r.scope + '/' + r.asset_name + '.' + r.mode;
        let serial = 2;
        while (paths.has(p)) {
          r.asset_name = r.name + '_' + suffix + '_' + serial++;
          p = r.scope + '/' + r.asset_name + '.' + r.mode;
        }
        // Replace the legacy duplicate-removal warning added below.
        r.warnings.push('같은 분류의 동일한 이름이 먼저 사용되어 이 항목은 추출에서 제외됩니다: ' + p);
        r.warnings[r.warnings.length - 1] = '동일한 리소스 명칭이 있어 파일명을 자동 분리했습니다: ' + p;
      }
      paths.add(p);
    }
  });
  return rows;
}
async function operation(msg) {
  if (busy) throw new Error('현재 작업이 끝난 후 다시 시도하세요.');
  if (!rootId || msg.root_id !== rootId) throw new Error('선택이 바뀌었습니다. 다시 분석하세요.');
  busy = true; cancelled = false; ++generation;
  try {
    const root = await figma.getNodeByIdAsync(rootId);
    if (!root || root.removed) throw new Error('대상 레이어가 삭제되었습니다.');
    // Whole-selection export is an operation intent, not a recommendation.
    // Saved native modes and stale UI drafts must not split its composition.
    const configs = msg.type === 'export' && msg.export_scope === 'composition'
      ? msg.configs.map(c => c.id === root.id ? { ...c, mode: c.mode === 'svg' ? 'svg' : 'png' } : c)
      : msg.configs;
    const rows = validateConfig(await inspect(root), configs, msg.type === 'save');
    if (msg.type === 'save') {
      let count = 0;
      for (const r of rows) {
        const n = await figma.getNodeByIdAsync(r.id);
        n.setPluginData(META, JSON.stringify({ scope: r.scope, mode: r.mode }));
        if (msg.rename_layers) n.name = r.name;
        count++;
      }
      post('saved', { count }); return;
    }
    const scale = Number(msg.scale);
    if (![1,2,3,4].includes(scale)) throw new Error('PNG 배율은 1~4 중에서 선택하세요.');
    const b = bounds(root), active = rows.filter(r => !r.suppressed && r.mode !== 'skip');
    if (b.width <= 0 || b.height <= 0 || !active.length) throw new Error('출력할 요소 또는 유효한 화면 크기가 없습니다.');
    // Stable destination even when the screen layer is renamed.
    const bundle = 'screen_' + key(root);
    const assets = active.filter(r => ['png','svg'].includes(r.mode));
    const manifest = { schema_version: 1, generator: 'Godot UI Exporter 1.1.0', screen_id: key(root), screen_name: root.name,
      export_scope: msg.export_scope === 'composition' ? 'composition' : 'resources',
      bundle_name: bundle, root_node_id: root.id, reference_size: { width: b.width, height: b.height },
      bounds_policy: 'absoluteBoundingBox; useAbsoluteBounds=true; no transparent trim; outside effects may be clipped',
      coordinates: 'axis-aligned bounds relative to selected root; logical pixels independent of export scale',
      godot_version: '4.x', scene_layout: 'fixed-reference flat draw order; responsive rules remain metadata',
      root_clips_content: !!root.clipsContent, nodes: active.map(r => Object.assign({}, r, {
        rect: { x: r.bounds.x - b.x, y: r.bounds.y - b.y, width: r.bounds.width, height: r.bounds.height },
        asset_path: ['png','svg'].includes(r.mode) ? 'assets/' + r.scope + '/' + r.asset_name + '.' + r.mode : null,
        export_scale: r.mode === 'png' ? scale : 1
      })), assets: [], warnings: [
        '자동 분류는 규칙 기반 제안입니다. 공통 후보는 사람이 확인하세요.',
        'generated.tscn은 기준 크기의 시각 배치 초안입니다. 버튼 동작·반응형 Container·9-slice는 자동 생성하지 않습니다.',
        'native 텍스트는 첫 스타일을 사용하며 폰트·줄바꿈을 Godot에서 확인해야 합니다.',
        '고정 경계 밖 효과는 잘릴 수 있습니다. 필요한 여백을 포함한 Frame을 추출하세요.'
      ] };
    post('export-start', { total: assets.length, bundle });
    let totalBytes = 0;
    for (let i = 0; i < assets.length; i++) {
      if (cancelled) throw new Error('내보내기를 취소했습니다.');
      const r = assets[i], n = await figma.getNodeByIdAsync(r.id);
      if (!n || n.removed) throw new Error(r.original_name + ': 레이어가 삭제되었습니다.');
      if (Math.max(r.bounds.width, r.bounds.height) * (r.mode === 'png' ? scale : 1) > 16384) throw new Error(r.name + ': 16,384px 초과. 배율을 낮추거나 나누세요.');
      const settings = r.mode === 'png' ? { format: 'PNG', constraint: { type: 'SCALE', value: scale }, contentsOnly: true, useAbsoluteBounds: true }
        : { format: 'SVG', svgOutlineText: true, svgIdAttribute: false, svgSimplifyStroke: true, contentsOnly: true, useAbsoluteBounds: true };
      const bytes = await n.exportAsync(settings);
      if (cancelled) throw new Error('내보내기를 취소했습니다.');
      totalBytes += bytes.length;
      if (totalBytes > 100 * 1024 * 1024) throw new Error('이미지 합계 100MB 초과. 대상을 나누거나 배율을 낮추세요.');
      const path = 'assets/' + r.scope + '/' + r.asset_name + '.' + r.mode;
      let pixelSize = null;
      if (r.mode === 'png' && bytes.length >= 24) {
        const u32 = offset => bytes[offset]*16777216 + bytes[offset+1]*65536 + bytes[offset+2]*256 + bytes[offset+3];
        pixelSize = { width: u32(16), height: u32(20) };
      }
      manifest.assets.push({ resource_id: r.resource_id, node_id: r.id, path, logical_size: { width: r.bounds.width, height: r.bounds.height }, pixel_size: pixelSize, scale: r.mode === 'png' ? scale : 1 });
      post('export-file', { path, bytes, done: i + 1, total: assets.length, name: r.name });
    }
    if (cancelled) throw new Error('내보내기를 취소했습니다.');
    post('export-complete', { manifest });
  } finally { busy = false; }
}
figma.ui.onmessage = async msg => {
  try {
    if (msg.type === 'cancel') { cancelled = true; return; }
    if (msg.type === 'pin') { pinned = !!msg.value; return; }
    if (msg.type === 'refresh' || msg.type === 'ready') return await scan(pinned);
    if (msg.type === 'focus') {
      const n = await figma.getNodeByIdAsync(msg.id);
      if (n && 'absoluteBoundingBox' in n) {
        if (figma.currentPage.selection.length !== 1 || figma.currentPage.selection[0].id !== n.id) {
          ignoreNextSelectionChange = true;
          figma.currentPage.selection = [n];
        }
        figma.viewport.scrollAndZoomIntoView([n]);
      }
      return;
    }
    if (['export','save'].includes(msg.type)) return await operation(msg);
  } catch (e) { post('error', { message: String(e.message || e), node_id: e.nodeId || null }); }
};
figma.on('selectionchange', () => {
  if (ignoreNextSelectionChange) { ignoreNextSelectionChange = false; return; }
  if (!pinned && !busy) scan(false);
});
