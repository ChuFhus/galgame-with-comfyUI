import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw new Error('hires workflow tests forbid network'); };
const { config } = await import('../src/config.js');
const { buildHiresWorkflow } = await import('../src/services/imageRefine.js');
const { guiToApi, apiToGui } = await import('../src/services/comfyClient.js');
const { WORKFLOW_TEMPLATE_HIRES, WORKFLOW_TEMPLATE_HIRES_ADVANCED, autoRestoreMissing, restoreWorkflow } = await import('../src/services/workflowTemplates.js');
const originalConfig = structuredClone(config.comfyui);
afterEach(() => { mock.restoreAll(); Object.assign(config.comfyui, structuredClone(originalConfig)); });

function build({ globals = [], chars = [], hires = [], legacy = false, scale = 1, blend = 0.2,
  workflowMode = 'advanced', upscaleModel = '', samplingMode = 'source', sourceSamplers = [[0, 'fixed', 12, 1, 'euler', 'simple', 1]] } = {}) {
  Object.assign(config.comfyui, { globalLora: globals, hiresLora: hires, hiresSteps: 35,
    hiresCfg: 5, hiresDenoise: 0.3, hiresMaxSize: 2000, hiresArtistMode: 'empty',
    hiresGlobalLoraScale: scale, hiresSourceBlend: blend, hiresSamplingMode: samplingMode, hiresUpscaleModel: upscaleModel, hiresWorkflowMode: workflowMode });
  const read = fs.readFileSync;
  mock.method(fs, 'readFileSync', (file, ...args) => {
    if (/放大细化工作流(?:-进阶)?\.json$/.test(String(file))) {
      const template = JSON.parse(String(file).endsWith('-进阶.json') ? WORKFLOW_TEMPLATE_HIRES_ADVANCED : WORKFLOW_TEMPLATE_HIRES);
      if (legacy) delete template.extra.linsheHires;
      return JSON.stringify(template);
    }
    if (/制图工作流(?:-pro)?\.json$/.test(String(file))) return JSON.stringify({ nodes: [
      { type: 'UNETLoader', widgets_values: ['customer-renamed-model.safetensors', 'default'] },
      ...sourceSamplers.map(widgets_values => ({ type: 'KSampler', widgets_values })),
    ] });
    return read.call(fs, file, ...args);
  });
  const exists = fs.existsSync;
  mock.method(fs, 'existsSync', file => /工作流.*\.json$/.test(String(file)) || exists.call(fs, file));
  return buildHiresWorkflow('a character in a library', { sourceMode: 'base', scene: 'moments', loras: chars }).wf;
}
const sampler = wf => wf.nodes.find(n => ['KSampler', 'UltimateSDUpscaleNoUpscale'].includes(n.type)).widgets_values;
const loras = wf => wf.nodes.filter(n => n.type === 'LoraLoaderModelOnly').map(n => n.widgets_values);

test('显式关闭超分后无模型依赖，跟随源采样器且独立控制重绘和原图融合', () => {
  const wf = build();
  assert.deepEqual(sampler(wf).slice(2, 7), [12, 1, 'euler', 'simple', 0.3]);
  assert.deepEqual(loras(wf), []);
  assert.ok(!wf.nodes.some(n => /UpscaleModel|ImageUpscaleWithModel/.test(n.type)));
  const api = guiToApi(wf);
  assert.equal(api['216'].class_type, 'UltimateSDUpscaleNoUpscale');
  assert.equal(api['216'].inputs.tile_width, 1024);
  assert.deepEqual(api['216'].inputs.upscaled_image, ['202', 0]);
  assert.deepEqual(api['219'].inputs.image1, ['216', 0]);
  assert.deepEqual(api['219'].inputs.image2, ['202', 0]);
  assert.equal(api['219'].inputs.blend_factor, 0.2);
  assert.deepEqual(api['218'].inputs.images, ['219', 0]);
});

for (const path of ['customer-style.safetensors', 'distillation.safetensors', 'negative-detail.safetensors']) {
  test('不根据 LoRA 名称推测用途或降低权重：' + path, () => {
    const globals = [{ path, weight: -0.8, triggerWord: 'custom-trigger' }];
    const wf = build({ globals });
    assert.deepEqual(loras(wf), [[path, -0.8]]);
    assert.equal(globals[0].weight, -0.8);
    assert.deepEqual(sampler(wf).slice(2, 7), [12, 1, 'euler', 'simple', 0.3]);
  });
}

test('显式倍率仅作用全局，角色及细化专用权重优先，接线完整', () => {
  const wf = build({ scale: 0.5, globals: [{ path: 'style', weight: 1 }, { path: 'override', weight: 0.8 }],
    chars: [{ path: 'character', weight: 0.9 }], hires: [{ path: 'override', weight: 0.7 }] });
  assert.deepEqual(loras(wf), [['style', 0.5], ['character', 0.9], ['override', 0.7]]);
  for (const [id, source, slot, target, targetSlot] of wf.links) {
    assert.ok(wf.nodes.find(n => n.id === source).outputs[slot].links.includes(id));
    assert.equal(wf.nodes.find(n => n.id === target).inputs[targetSlot].link, id);
  }
});

test('零倍率取消全局加载和独立触发词，不改变角色 LoRA', () => {
  const wf = build({ scale: 0, globals: [{ path: 'style', weight: 1, triggerWord: 'style-trigger' }],
    chars: [{ path: 'character', weight: 0.8, triggerWord: 'character-trigger' }] });
  assert.deepEqual(loras(wf), [['character', 0.8]]);
  assert.equal(wf.nodes.find(n => n.title === 'lora触发词').widgets_values[0], 'character-trigger');
});

test('禁用、场景过滤和零权重都不加载', () => {
  const wf = build({ globals: [{ path: 'off', enabled: false }, { path: 'portrait', scenes: ['portrait'] }, { path: 'zero', weight: 0 }] });
  assert.deepEqual(loras(wf), []);
  assert.equal(wf.nodes.find(n => n.title === 'lora触发词').widgets_values[0], '');
});

test('自定义采样设置不被静默封顶，原图保留 0 有效', () => {
  const wf = build({ samplingMode: 'custom', blend: 0 });
  assert.deepEqual(sampler(wf).slice(2, 7), [35, 5, 'er_sde', 'beta', 0.3]);
  assert.equal(guiToApi(wf)['219'].inputs.blend_factor, 0);
});

for (const sourceSamplers of [[], [[0, 'fixed', 10, 1, 'euler', 'simple', 1], [0, 'fixed', 20, 4, 'euler', 'simple', 1]]]) {
  test('源采样器不可唯一确定时回退显式参数：' + sourceSamplers.length, () => {
    assert.deepEqual(sampler(build({ sourceSamplers })).slice(2, 7), [35, 5, 'er_sde', 'beta', 0.3]);
  });
}

test('源模型重命名不影响 Base 参数继承', () => {
  const wf = build({ sourceSamplers: [[0, 'fixed', 32, 4.5, 'er_sde', 'beta', 1]] });
  assert.deepEqual(sampler(wf).slice(2, 7), [32, 4.5, 'er_sde', 'beta', 0.3]);
});

test('无 v3 标记旧流程不改变采样策略', () => {
  assert.deepEqual(sampler(build({ legacy: true })).slice(2, 7), [35, 5, 'er_sde', 'beta', 0.3]);
});

test('通用设置保存并重载，零值有效，无效数值不污染配置', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { initSettingsHandle, loadSystemSettings } = await import('../src/db/settings.js');
  const { updateHiresSettings } = await import('../src/config.js');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT, updated_at TEXT)');
  initSettingsHandle(db);
  try {
    updateHiresSettings({ samplingMode: 'custom', globalLoraScale: 0, sourceBlend: 0, upscaleModel: '', workflowMode: 'advanced' });
    config.comfyui.hiresSamplingMode = 'source';
    config.comfyui.hiresGlobalLoraScale = 1;
    config.comfyui.hiresSourceBlend = 0.2;
    loadSystemSettings(db);
    assert.equal(config.comfyui.hiresSamplingMode, 'custom');
    assert.equal(config.comfyui.hiresUpscaleModel, '');
    assert.equal(config.comfyui.hiresWorkflowMode, 'advanced');
    updateHiresSettings({ workflowMode: 'unknown' });
    assert.equal(config.comfyui.hiresWorkflowMode, 'advanced');
    updateHiresSettings({ workflowMode: 'basic' });
    config.comfyui.hiresWorkflowMode = 'advanced';
    loadSystemSettings(db);
    assert.equal(config.comfyui.hiresWorkflowMode, 'basic');
    assert.equal(config.comfyui.hiresGlobalLoraScale, 0);
    assert.equal(config.comfyui.hiresSourceBlend, 0);
    db.prepare('DELETE FROM system_settings WHERE setting_key = ?').run('comfy_hires_sampling_mode');
    db.prepare('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)').run('comfy_hires_cfg', '1');
    config.comfyui.hiresSamplingMode = 'source';
    loadSystemSettings(db);
    assert.equal(config.comfyui.hiresSamplingMode, 'custom', '已有用户显式采样参数继续生效');
    updateHiresSettings({ samplingMode: 'invalid', globalLoraScale: NaN, sourceBlend: Infinity });
    assert.equal(config.comfyui.hiresSamplingMode, 'custom');
    assert.equal(config.comfyui.hiresGlobalLoraScale, 0);
    assert.equal(config.comfyui.hiresSourceBlend, 0);
  } finally {
    initSettingsHandle(null);
    db.close();
  }
});


test('超分模型独立于任意全局 LoRA，目标尺寸与原图支路一致', () => {
  const wf = build({ upscaleModel: 'customer-upscaler.pth', globals: [{ path: 'any-style.safetensors', weight: 1 }] });
  const api = guiToApi(wf);
  assert.equal(api['220'].inputs.model_name, 'customer-upscaler.pth');
  assert.deepEqual(api['221'].inputs.image, ['201', 0]);
  assert.deepEqual(api['216'].inputs.upscaled_image, ['222', 0]);
  assert.equal(api['222'].inputs.largest_size, api['202'].inputs.largest_size);
  assert.deepEqual(loras(wf), [['any-style.safetensors', 1]]);
  for (const [id, source, slot, target, targetSlot] of wf.links) {
    assert.ok(wf.nodes.find(n => n.id === source).outputs[slot].links.includes(id));
    assert.equal(wf.nodes.find(n => n.id === target).inputs[targetSlot].link, id);
  }
});


test('分块采样 API / GUI 往返保留 seed 控件后的全部参数', () => {
  const api = guiToApi(build({ upscaleModel: 'any.pth' }));
  const sampler = api['216'];
  assert.equal(sampler.inputs.steps, 12);
  assert.equal(sampler.inputs.cfg, 1);
  assert.equal(sampler.inputs.sampler_name, 'euler');
  assert.equal(sampler.inputs.scheduler, 'simple');
  assert.equal(sampler.inputs.mode_type, 'Chess');
  assert.equal(sampler.inputs.tile_padding, 128);
  assert.equal(sampler.inputs.force_uniform_tiles, true);
  const roundtrip = Object.values(guiToApi(apiToGui(api))).find(n => n.class_type === 'UltimateSDUpscaleNoUpscale');
  for (const [key, value] of Object.entries(sampler.inputs)) {
    if (!Array.isArray(value)) assert.equal(roundtrip.inputs[key], value, key);
  }
});


test('默认基础版保留原流程，不含任何进阶节点或超分模型依赖', () => {
  assert.equal(originalConfig.hiresWorkflowMode, 'basic');
  const wf = build({ workflowMode: 'basic', upscaleModel: 'missing-model.pth', globals: [{ path: 'any-style', weight: 0.7 }] });
  const api = guiToApi(wf);
  assert.equal(api['216'].class_type, 'KSampler');
  assert.equal(api['203'].class_type, 'VAEEncode');
  assert.equal(api['217'].class_type, 'VAEDecode');
  assert.deepEqual(api['218'].inputs.images, ['217', 0]);
  assert.ok(!wf.nodes.some(n => /Ultimate|UpscaleModel|ImageBlend/.test(n.type)));
  assert.deepEqual(sampler(wf).slice(2, 7), [35, 5, 'er_sde', 'beta', 0.3]);
  assert.deepEqual(loras(wf), [['any-style', 0.7]]);
});

test('缺失恢复及手动恢复都包含两套 HiresFix，自动恢复不覆盖现存文件', () => {
  const writes = [];
  mock.method(fs, 'existsSync', () => false);
  mock.method(fs, 'mkdirSync', () => {});
  mock.method(fs, 'writeFileSync', (file, content) => writes.push([String(file), content]));
  autoRestoreMissing();
  assert.ok(writes.some(([p, c]) => p.endsWith('放大细化工作流.json') && c === WORKFLOW_TEMPLATE_HIRES));
  assert.ok(writes.some(([p, c]) => p.endsWith('放大细化工作流-进阶.json') && c === WORKFLOW_TEMPLATE_HIRES_ADVANCED));
  writes.length = 0;
  mock.method(fs, 'existsSync', () => true);
  autoRestoreMissing();
  assert.equal(writes.length, 0);
  restoreWorkflow();
  assert.equal(writes.length, 4);
});
