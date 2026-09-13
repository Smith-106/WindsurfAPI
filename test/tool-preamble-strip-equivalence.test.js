// Byte-identity pin for the tool-preamble tier ladder (chat.js:applyToolPreambleBudget)
// and for the schema-compact `$ref` inliner it calls
// (tool-emulation.js:buildSchemaCompactToolPreambleForProto).
//
// WHY THIS FILE EXISTS
// applyToolPreambleBudget builds up to four candidate preamble strings per request
// and discards every one that does not fit under TOOL_PREAMBLE_SOFT_BYTES. On a
// 34-tool agent request that is ~584 KB of strings built to ship ~3 KB (measured on
// the real path with upstream stubbed: tmp/perf/p3-preamble-ladder.mjs). The tiers
// that get thrown away are free to become CHEAPER; they are not free to CHANGE,
// because which tier wins — and every byte of the tier that ships, plus the
// fullBytes/finalBytes/tier fields the caller logs and returns — is observable.
//
// Two independent pins:
//
//   1. DIFFERENTIAL. A frozen copy of the master inliner (refStrip, below — copied
//      verbatim from 4cbd029) is run side by side with the real builder over a
//      battery of schemas. Every tool's `Params:` line in the real preamble must be
//      byte-identical to the frozen reference, and the shared 50000-node budget
//      must be consumed in the same order (the battery includes fan-out schemas
//      that exhaust it).
//
//   2. GOLDEN. The ladder's whole result (tier / ok / compacted / fullBytes /
//      finalBytes / sha256 of the preamble) is pinned against values captured from
//      master (4cbd029) for 15 shapes x 3 cap settings x {emulation, native}.
//
// A third section pins that the node-budget exhaustion WARNING still fires, with
// the same text, through the ladder — the optimization added to the stripper gives
// it a per-build cache object, so its accounting is covered explicitly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { applyToolPreambleBudget, injectPreambleIntoSystemPrompt } from '../src/handlers/chat.js';
import {
  buildSchemaCompactToolPreambleForProto, buildToolPreambleForProto,
  buildSkinnyToolPreambleForProto, buildCompactToolPreambleForProto,
} from '../src/handlers/tool-emulation.js';
import { log } from '../src/config.js';

// ─── shape battery ─────────────────────────────────────────────────────────
function makeTools(count, propCount = 18) {
  return Array.from({ length: count }, (_, i) => ({
    type: 'function',
    function: {
      name: `mcp_tool_${i}`,
      description: `Verbose MCP tool ${i} description. `.repeat(20),
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: propCount }, (_, j) => [`field_${j}`, {
            type: 'string',
            description: `Verbose field ${j} for tool ${i}. `.repeat(12),
            enum: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'],
          }])
        ),
        required: Array.from({ length: propCount }, (_, j) => `field_${j}`),
      },
    },
  }));
}

/** $defs L0..Lk, each level referenced from two sibling positions. No cycles. */
function fanoutSchema(levels) {
  const $defs = {};
  for (let i = 0; i <= levels; i++) {
    if (i === levels) { $defs[`L${i}`] = { type: 'string' }; continue; }
    $defs[`L${i}`] = {
      type: 'object',
      properties: { a: { $ref: `#/$defs/L${i + 1}` }, b: { $ref: `#/$defs/L${i + 1}` } },
    };
  }
  return { type: 'object', $defs, properties: { root: { $ref: '#/$defs/L0' } } };
}
const fanoutTool = (levels, name = 'fanout') => ({ type: 'function', function: { name, parameters: fanoutSchema(levels) } });

// The same $ref string under two DIFFERENT roots, resolving to different schemas.
// Any memo of $ref resolution must be keyed per root or this pair collides.
const sameRefTwoRoots = () => [
  { type: 'function', function: { name: 'A', parameters: { type: 'object', $defs: { L0: { type: 'string' } }, properties: { r: { $ref: '#/$defs/L0' } } } } },
  { type: 'function', function: { name: 'B', parameters: { type: 'object', $defs: { L0: { type: 'integer', minimum: 3 } }, properties: { r: { $ref: '#/$defs/L0' } } } } },
];

/** The client-controllable amplifier: a diamond plus prose-free padding. */
function paddedDiamond(levels, padCount = 400) {
  const defs = {};
  for (let i = 0; i < levels; i++) defs[`L${i}`] = { type: 'object', properties: { a: { $ref: `#/$defs/L${i + 1}` }, b: { $ref: `#/$defs/L${i + 1}` } } };
  defs[`L${levels}`] = { type: 'object', properties: { leaf: { type: 'string' } } };
  const pad = {};
  for (let i = 0; i < padCount; i++) pad[`pad_${i}`] = { type: 'string', enum: ['a', 'b', 'c'], items: [{ type: 'string' }] };
  return { type: 'object', properties: { root: { $ref: '#/$defs/L0' }, ...pad }, $defs: defs };
}

const SHAPES = {
  none: () => [],
  tiny: () => [{ type: 'function', function: { name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'path' } }, required: ['file_path'] } } }],
  three_tools: () => makeTools(3, 2),
  eight_tools: () => makeTools(8, 6),
  tools25: () => makeTools(25, 8),
  tools56: () => makeTools(56, 18),
  tools2000x1: () => makeTools(2000, 1),
  fanout9: () => [fanoutTool(9, 'Modest')],
  same_ref_two_roots: () => sameRefTwoRoots(),
  fanout14: () => [fanoutTool(14, 'Diamond')],
  fanout16: () => [fanoutTool(16, 'Diamond'), { type: 'function', function: { name: 'Innocent', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }],
  nested_diamond12: () => [{ type: 'function', function: { name: 'diamond', description: 'd', parameters: paddedDiamond(12) } }],
  nested_diamond14: () => [{ type: 'function', function: { name: 'diamond', description: 'd', parameters: paddedDiamond(14) } }],
  unicode: () => [
    { type: 'function', function: { name: '工具_读取', description: '读取文件内容 🚀 — with an em dash and 中文说明。', parameters: { type: 'object', properties: { 路径: { type: 'string', description: '要读取的路径 ✅' }, 'emoji😀': { type: 'boolean' } } } } },
    { type: 'function', function: { name: 'utf8_áéí', description: 'plus/minus ± and ° symbols', parameters: { type: 'object', properties: { x: { type: 'string' }, y: { enum: ['α', 'β'] } } } } },
  ],
  keyword_zoo: () => [{
    type: 'function',
    function: {
      name: 'zoo',
      parameters: {
        type: 'object',
        properties: {
          a: { anyOf: [{ type: 'string' }, { type: 'number' }] },
          b: { oneOf: [{ const: 'x' }, { const: 'y' }], title: 'dropped', default: 'also dropped', examples: ['e1', 'e2'] },
          c: { type: 'array', items: [{ type: 'string' }, { type: 'null' }], $comment: 'dropped' },
          d: { allOf: [{ type: 'object', properties: { z: { type: 'string', format: 'date-time' } } }] },
          e: { type: 'object', additionalProperties: false },
          f: { type: 'object', additionalProperties: true },
          g: { type: 'object', additionalProperties: { type: 'string' } },
          h: { enum: [1, 2, 3], const: 2, format: 'int32' },
          i: { type: 'object', properties: {}, required: [] },
        },
        required: ['a'],
        additionalProperties: false,
      },
    },
  }],
  malformed: () => [
    { type: 'function' },
    { type: 'not-function', function: { name: 'ignored' } },
    { type: 'function', function: { name: 'no_params', description: 'no schema at all' } },
    { type: 'function', function: { name: 'empty_params', parameters: {} } },
    { type: 'function', function: { name: 'null_params', parameters: null } },
    { type: 'function', function: { name: 'undef_val', parameters: { type: 'object', properties: { u: undefined, k: 'not an object' } } } },
    { type: 'function', function: { name: 'dangling_ref', parameters: { type: 'object', properties: { r: { $ref: '#/$defs/missing' }, n: { $ref: 42 } } } } },
    { type: 'function', function: { name: 'self_cycle', parameters: { type: 'object', $defs: { S: { type: 'object', properties: { next: { $ref: '#/$defs/S' } } } }, properties: { root: { $ref: '#/$defs/S' } } } } },
  ],
};

// ─── frozen reference: master's stripSchemaDocs, copied verbatim from 4cbd029 ──
const REF_NODE_BUDGET = 50000;
function refBudget() { return { remaining: REF_NODE_BUDGET, exhausted: false }; }

function refResolveLocalSchemaRef(ref, root) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = root;
  for (const part of parts) {
    if (!cur || typeof cur !== 'object' || !(part in cur)) return null;
    cur = cur[part];
  }
  return cur && typeof cur === 'object' ? cur : null;
}

function refStrip(schema, root = schema, refStack = [], budget = refBudget()) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(s => refStrip(s, root, refStack, budget));
  if (budget.remaining <= 0) { budget.exhausted = true; return { type: 'object' }; }
  budget.remaining--;
  if (typeof schema.$ref === 'string') {
    const ref = schema.$ref;
    if (refStack.includes(ref)) return { type: 'object' };
    const resolved = refResolveLocalSchemaRef(ref, root);
    if (!resolved) return { type: 'object' };
    const siblings = Object.fromEntries(Object.entries(schema).filter(([k]) => k !== '$ref'));
    return refStrip({ ...resolved, ...siblings }, root, [...refStack, ref], budget);
  }
  const KEEP = new Set(['type', 'enum', 'properties', 'items', 'required', 'oneOf', 'anyOf', 'allOf', 'const', 'format', 'additionalProperties']);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!KEEP.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      const props = {};
      for (const [pk, pv] of Object.entries(v)) props[pk] = refStrip(pv, root, refStack, budget);
      out[k] = props;
    } else if ((k === 'items' || k === 'oneOf' || k === 'anyOf' || k === 'allOf') && v) {
      out[k] = refStrip(v, root, refStack, budget);
    } else if (k === 'additionalProperties') {
      if (v === false) out[k] = false;
      else if (v && typeof v === 'object') out[k] = refStrip(v, root, refStack, budget);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** `Params:` payload per tool, with ONE budget shared across the tool list. */
function referenceParams(tools) {
  const budget = refBudget();
  const rows = [];
  for (const t of tools) {
    if (t?.type !== 'function' || !t.function) continue;
    const { name, parameters } = t.function;
    if (!parameters) { rows.push([name, null]); continue; }
    rows.push([name, JSON.stringify(refStrip(parameters, parameters, [], budget))]);
  }
  return rows;
}

/** `Params:` payload per tool, as it appears in the real builder's output. */
function actualParams(preamble) {
  const rows = [];
  for (const section of preamble.split('\n### ').slice(1)) {
    const name = section.slice(0, section.indexOf('\n'));
    const m = section.match(/^Params: (.*)$/m);
    rows.push([name, m ? m[1] : null]);
  }
  return rows;
}

function withDefaultCaps(fn) {
  const soft = process.env.TOOL_PREAMBLE_SOFT_BYTES;
  const hard = process.env.TOOL_PREAMBLE_HARD_BYTES;
  delete process.env.TOOL_PREAMBLE_SOFT_BYTES;
  delete process.env.TOOL_PREAMBLE_HARD_BYTES;
  try { return fn(); } finally {
    if (soft === undefined) delete process.env.TOOL_PREAMBLE_SOFT_BYTES; else process.env.TOOL_PREAMBLE_SOFT_BYTES = soft;
    if (hard === undefined) delete process.env.TOOL_PREAMBLE_HARD_BYTES; else process.env.TOOL_PREAMBLE_HARD_BYTES = hard;
  }
}

test('schema-compact inliner: real builder output equals the frozen master inliner, per tool', () => {
  const representative = [
    'tiny', 'three_tools', 'eight_tools', 'tools25', 'unicode', 'keyword_zoo', 'malformed',
    'same_ref_two_roots', 'fanout9', 'fanout14', 'fanout16', 'nested_diamond12',
  ];
  for (const shape of representative) {
    const tools = SHAPES[shape]();
    for (const nativeStructured of [false, true]) {
      const opts = nativeStructured ? { nativeStructured: true } : {};
      const preamble = buildSchemaCompactToolPreambleForProto(tools, 'auto', 'cwd: D:/w', 'claude-sonnet-4.6', null, 'chat', opts);
      const expected = referenceParams(tools);
      const actual = actualParams(preamble);
      const label = `${shape} nativeStructured=${nativeStructured}`;
      assert.deepEqual(
        actual.map(([n]) => n), expected.map(([n]) => n),
        `${label}: the set/order of tools that emit a Params line changed`,
      );
      for (let i = 0; i < expected.length; i++) {
        assert.equal(actual[i][1], expected[i][1],
          `${label}: Params payload of tool "${expected[i][0]}" differs from the master inliner`);
      }
    }
  }
});

test('schema-compact inliner: the shared node budget is consumed in the same order', () => {
  // Both builders must exhaust the budget at the SAME tool, or the warning would
  // name a different schema. fanout16 puts an innocent tool after the diamond.
  const tools = SHAPES.fanout16();
  const warns = [];
  const original = log.warn;
  log.warn = (...args) => { warns.push(args.join(' ')); };
  try {
    const preamble = buildSchemaCompactToolPreambleForProto(tools, 'auto', 'cwd: D:/w', 'claude-sonnet-4.6', null, 'chat', {});
    const expected = referenceParams(tools);
    const actual = actualParams(preamble);
    for (let i = 0; i < expected.length; i++) {
      assert.equal(actual[i][1], expected[i][1], `Params payload of "${expected[i][0]}" differs from master`);
    }
  } finally { log.warn = original; }
  assert.equal(warns.length, 1, `exactly one exhaustion warning expected, got ${warns.length}`);
  assert.match(warns[0], /Diamond/, 'warning must still name the tool whose schema exhausted the budget');
  assert.match(warns[0], /50000/, 'warning must still state the node budget');
  assert.equal(/Innocent/.test(warns[0]), false, 'warning must not blame the tool that came after the fan-out');
});

// ─── golden ladder results, captured from master 4cbd029 ───────────────────
// shape / soft / hard / nativeStructured -> the whole returned result plus the
// sha256 of the chosen preamble. `soft`/`hard` absent = default caps.
const GOLDENS = [
  {"shape":"none","nativeStructured":false,"tier":"empty","ok":true,"compacted":false,"fullBytes":0,"finalBytes":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
  {"shape":"none","nativeStructured":true,"tier":"empty","ok":true,"compacted":false,"fullBytes":0,"finalBytes":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
  {"shape":"none","soft":10000,"hard":48000,"nativeStructured":false,"tier":"empty","ok":true,"compacted":false,"fullBytes":0,"finalBytes":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
  {"shape":"none","soft":10000,"hard":48000,"nativeStructured":true,"tier":"empty","ok":true,"compacted":false,"fullBytes":0,"finalBytes":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
  {"shape":"none","soft":1,"hard":100000,"nativeStructured":false,"tier":"empty","ok":true,"compacted":false,"fullBytes":0,"finalBytes":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
  {"shape":"none","soft":1,"hard":100000,"nativeStructured":true,"tier":"empty","ok":true,"compacted":false,"fullBytes":0,"finalBytes":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
  {"shape":"tiny","nativeStructured":false,"tier":"full","ok":true,"compacted":false,"fullBytes":3043,"finalBytes":3043,"sha256":"f73695078c4c4b539e4bd3cac34740dc7d3ec3f537b749bcd1af1392ea7b7668"},
  {"shape":"tiny","nativeStructured":true,"tier":"full","ok":true,"compacted":false,"fullBytes":1093,"finalBytes":1093,"sha256":"34745da352bbdbf394e87a9592e9645afcb1fba760e7bf11274ccdd1b284b038"},
  {"shape":"tiny","soft":10000,"hard":48000,"nativeStructured":false,"tier":"full","ok":true,"compacted":false,"fullBytes":3043,"finalBytes":3043,"sha256":"f73695078c4c4b539e4bd3cac34740dc7d3ec3f537b749bcd1af1392ea7b7668"},
  {"shape":"tiny","soft":10000,"hard":48000,"nativeStructured":true,"tier":"full","ok":true,"compacted":false,"fullBytes":1093,"finalBytes":1093,"sha256":"34745da352bbdbf394e87a9592e9645afcb1fba760e7bf11274ccdd1b284b038"},
  {"shape":"tiny","soft":1,"hard":100000,"nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":3043,"finalBytes":3038,"sha256":"cb523969281920ed7c726b31eae36f3e1819592840ae393f1ef0840664806bd6"},
  {"shape":"tiny","soft":1,"hard":100000,"nativeStructured":true,"tier":"names-only","ok":true,"compacted":true,"fullBytes":1093,"finalBytes":1039,"sha256":"6de29873d2f07705078dd8e4d1c8f8138a0b7946d81eb1449b2c402fb1bd9316"},
  {"shape":"three_tools","nativeStructured":false,"tier":"full","ok":true,"compacted":false,"fullBytes":8085,"finalBytes":8085,"sha256":"fd5ead4820292df93e2bb886bf9837dd84cf329cccc1d1c9aeba71415cf945d4"},
  {"shape":"three_tools","nativeStructured":true,"tier":"full","ok":true,"compacted":false,"fullBytes":6135,"finalBytes":6135,"sha256":"4e27c2581c00b1d4e82649090aa68c7c5eed48e256a5a0c2fe2abb5b33561bf7"},
  {"shape":"three_tools","soft":10000,"hard":48000,"nativeStructured":false,"tier":"full","ok":true,"compacted":false,"fullBytes":8085,"finalBytes":8085,"sha256":"fd5ead4820292df93e2bb886bf9837dd84cf329cccc1d1c9aeba71415cf945d4"},
  {"shape":"three_tools","soft":10000,"hard":48000,"nativeStructured":true,"tier":"full","ok":true,"compacted":false,"fullBytes":6135,"finalBytes":6135,"sha256":"4e27c2581c00b1d4e82649090aa68c7c5eed48e256a5a0c2fe2abb5b33561bf7"},
  {"shape":"three_tools","soft":1,"hard":100000,"nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":8085,"finalBytes":2881,"sha256":"fb0be2122dc6ba1a1593be3124c899795a6b14e111ba56267ccc2c7ed8f339f4"},
  {"shape":"three_tools","soft":1,"hard":100000,"nativeStructured":true,"tier":"names-only","ok":true,"compacted":true,"fullBytes":6135,"finalBytes":882,"sha256":"b7c26350f7b74ae191fe037f557efb00cadb9b354da97d036b397d5ed74a255e"},
  {"shape":"eight_tools","nativeStructured":false,"tier":"schema-compact","ok":true,"compacted":true,"fullBytes":34201,"finalBytes":7689,"sha256":"5afd0226fcfe64b6a7d1756a399c43ba0d15a7ea32fdcbc320065c6a5e933ec9"},
  {"shape":"eight_tools","nativeStructured":true,"tier":"schema-compact","ok":true,"compacted":true,"fullBytes":32251,"finalBytes":5739,"sha256":"50195e539855cd6f53929c754f4c40b905e3bf8b2cb13c4b5eb70042965ed379"},
  {"shape":"eight_tools","soft":10000,"hard":48000,"nativeStructured":false,"tier":"schema-compact","ok":true,"compacted":true,"fullBytes":34201,"finalBytes":7689,"sha256":"5afd0226fcfe64b6a7d1756a399c43ba0d15a7ea32fdcbc320065c6a5e933ec9"},
  {"shape":"eight_tools","soft":10000,"hard":48000,"nativeStructured":true,"tier":"schema-compact","ok":true,"compacted":true,"fullBytes":32251,"finalBytes":5739,"sha256":"50195e539855cd6f53929c754f4c40b905e3bf8b2cb13c4b5eb70042965ed379"},
  {"shape":"eight_tools","soft":1,"hard":100000,"nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":34201,"finalBytes":2941,"sha256":"c3d4e8a9b26e2d10e6b9f8bfeaf7e89c0bbca0c032088f1c45d65836a0fa5db3"},
  {"shape":"eight_tools","soft":1,"hard":100000,"nativeStructured":true,"tier":"names-only","ok":true,"compacted":true,"fullBytes":32251,"finalBytes":942,"sha256":"e3a96260bd915ac27a9098368e5d45ddb07c0c2236dc85f00dfa2b3c263b020e"},
  {"shape":"tools25","nativeStructured":false,"tier":"schema-compact","ok":true,"compacted":true,"fullBytes":129654,"finalBytes":22829,"sha256":"8f3e9e1a431752b291e8d71a0bb9f447998673b02e5a6b70556f7b3ac9127ed4"},
  {"shape":"tools25","nativeStructured":true,"tier":"schema-compact","ok":true,"compacted":true,"fullBytes":127704,"finalBytes":20879,"sha256":"84b7dc35d010552b58cbb1b84b2a7f8840246ffb07ee27a09280eed8f2716b46"},
  {"shape":"tools25","soft":10000,"hard":48000,"nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":129654,"finalBytes":3160,"sha256":"6d22e4a99071c2bb167e8e27525aa031c6ba78ab787538fdaacf7cc3daa089ef"},
  {"shape":"tools25","soft":10000,"hard":48000,"nativeStructured":true,"tier":"names-only","ok":true,"compacted":true,"fullBytes":127704,"finalBytes":1161,"sha256":"5eac06fbc1280ebff4d2320d388f0f23f3e8aecf783a95d6e41a40dba88f5120"},
  {"shape":"tools25","soft":1,"hard":100000,"nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":129654,"finalBytes":3160,"sha256":"6d22e4a99071c2bb167e8e27525aa031c6ba78ab787538fdaacf7cc3daa089ef"},
  {"shape":"tools25","soft":1,"hard":100000,"nativeStructured":true,"tier":"names-only","ok":true,"compacted":true,"fullBytes":127704,"finalBytes":1161,"sha256":"5eac06fbc1280ebff4d2320d388f0f23f3e8aecf783a95d6e41a40dba88f5120"},
  {"shape":"tools56","nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":598863,"finalBytes":3563,"sha256":"511003d394632d20ce0bd5b97f3c904325046a605c937c978f50c8674c5a3127"},
  {"shape":"tools56","nativeStructured":true,"tier":"names-only","ok":true,"compacted":true,"fullBytes":596913,"finalBytes":1564,"sha256":"5b6f91a3a30c792388eb57490ffd7ca6642ab1cb6028b5b0ae8ac74c1fa7b74e"},
  {"shape":"tools56","soft":10000,"hard":48000,"nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":598863,"finalBytes":3563,"sha256":"511003d394632d20ce0bd5b97f3c904325046a605c937c978f50c8674c5a3127"},
  {"shape":"tools56","soft":10000,"hard":48000,"nativeStructured":true,"tier":"names-only","ok":true,"compacted":true,"fullBytes":596913,"finalBytes":1564,"sha256":"5b6f91a3a30c792388eb57490ffd7ca6642ab1cb6028b5b0ae8ac74c1fa7b74e"},
  {"shape":"tools56","soft":1,"hard":100000,"nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":598863,"finalBytes":3563,"sha256":"511003d394632d20ce0bd5b97f3c904325046a605c937c978f50c8674c5a3127"},
  {"shape":"tools56","soft":1,"hard":100000,"nativeStructured":true,"tier":"names-only","ok":true,"compacted":true,"fullBytes":596913,"finalBytes":1564,"sha256":"5b6f91a3a30c792388eb57490ffd7ca6642ab1cb6028b5b0ae8ac74c1fa7b74e"},
  {"shape":"tools2000x1","nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":2722019,"finalBytes":31735,"sha256":"108a057070b0159c7fd9c28da1720f36726a1c94997848bc494df3a44e80a230"},
  {"shape":"tools2000x1","nativeStructured":true,"tier":"names-only","ok":true,"compacted":true,"fullBytes":2720069,"finalBytes":29736,"sha256":"d69181b85f6cd3618349bc1ca1ec493b7bf5a59896b1727e745203a271b72574"},
  {"shape":"tools2000x1","soft":10000,"hard":48000,"nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":2722019,"finalBytes":31735,"sha256":"108a057070b0159c7fd9c28da1720f36726a1c94997848bc494df3a44e80a230"},
  {"shape":"tools2000x1","soft":10000,"hard":48000,"nativeStructured":true,"tier":"names-only","ok":true,"compacted":true,"fullBytes":2720069,"finalBytes":29736,"sha256":"d69181b85f6cd3618349bc1ca1ec493b7bf5a59896b1727e745203a271b72574"},
  {"shape":"tools2000x1","soft":1,"hard":100000,"nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":2722019,"finalBytes":31735,"sha256":"108a057070b0159c7fd9c28da1720f36726a1c94997848bc494df3a44e80a230"},
  {"shape":"tools2000x1","soft":1,"hard":100000,"nativeStructured":true,"tier":"names-only","ok":true,"compacted":true,"fullBytes":2720069,"finalBytes":29736,"sha256":"d69181b85f6cd3618349bc1ca1ec493b7bf5a59896b1727e745203a271b72574"},
  {"shape":"fanout9","nativeStructured":false,"tier":"full","ok":true,"compacted":false,"fullBytes":4511,"finalBytes":4511,"sha256":"e5c28564d72e9d68210a597a7445c1bcc93729625166d36dba1223c85906afdc"},
  {"shape":"fanout9","nativeStructured":true,"tier":"full","ok":true,"compacted":false,"fullBytes":2561,"finalBytes":2561,"sha256":"d14b4473612536607bca81e64dadf46d934a41c58eab6ba6274f99c409d044e5"},
  {"shape":"fanout9","soft":10000,"hard":48000,"nativeStructured":false,"tier":"full","ok":true,"compacted":false,"fullBytes":4511,"finalBytes":4511,"sha256":"e5c28564d72e9d68210a597a7445c1bcc93729625166d36dba1223c85906afdc"},
  {"shape":"fanout9","soft":10000,"hard":48000,"nativeStructured":true,"tier":"full","ok":true,"compacted":false,"fullBytes":2561,"finalBytes":2561,"sha256":"d14b4473612536607bca81e64dadf46d934a41c58eab6ba6274f99c409d044e5"},
  {"shape":"fanout9","soft":1,"hard":100000,"nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":4511,"finalBytes":2853,"sha256":"8fa03e423f28229a8cbff8618c0cdeb483a1d2277e4a3ef7fe3af054cf573a21"},
  {"shape":"fanout9","soft":1,"hard":100000,"nativeStructured":true,"tier":"names-only","ok":true,"compacted":true,"fullBytes":2561,"finalBytes":854,"sha256":"27c0c423c78543ae3945c1c21b2a5173598de9c094d322ace0e02fd9d99b3ff9"},
  {"shape":"same_ref_two_roots","nativeStructured":false,"tier":"full","ok":true,"compacted":false,"fullBytes":3030,"finalBytes":3030,"sha256":"015b815b59682bfc4ead91cfca9fc1922ec992d23ba533a7e7447f21deb47cb1"},
  {"shape":"same_ref_two_roots","nativeStructured":true,"tier":"full","ok":true,"compacted":false,"fullBytes":1080,"finalBytes":1080,"sha256":"fcb00a345f4f455ab2a50f4c2e040c9789158096cf130f59af9788569c9fdde5"},
  {"shape":"same_ref_two_roots","soft":10000,"hard":48000,"nativeStructured":false,"tier":"full","ok":true,"compacted":false,"fullBytes":3030,"finalBytes":3030,"sha256":"015b815b59682bfc4ead91cfca9fc1922ec992d23ba533a7e7447f21deb47cb1"},
  {"shape":"same_ref_two_roots","soft":10000,"hard":48000,"nativeStructured":true,"tier":"full","ok":true,"compacted":false,"fullBytes":1080,"finalBytes":1080,"sha256":"fcb00a345f4f455ab2a50f4c2e040c9789158096cf130f59af9788569c9fdde5"},
  {"shape":"same_ref_two_roots","soft":1,"hard":100000,"nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":3030,"finalBytes":2851,"sha256":"a46175a97848a05a0d85a5fc4c0223108fc432b3d4ec06e70d2fdb5236e77465"},
  {"shape":"same_ref_two_roots","soft":1,"hard":100000,"nativeStructured":true,"tier":"names-only","ok":true,"compacted":true,"fullBytes":1080,"finalBytes":852,"sha256":"3df74bf13816babc74caa7914858e252f87090ebe311b66fe95153d50498c4f9"},
  {"shape":"fanout14","nativeStructured":false,"tier":"full","ok":true,"compacted":false,"fullBytes":5457,"finalBytes":5457,"sha256":"7d1d8efb0af37ddad87921600f04041e12c8a215be15e4fee2471984b7498035"},
  {"shape":"fanout14","nativeStructured":true,"tier":"full","ok":true,"compacted":false,"fullBytes":3507,"finalBytes":3507,"sha256":"2f6bd3af3268f2d8548fd47c3b9aa9f48a76201a5e8eb6ff51f7aa273f5a46dc"},
  {"shape":"fanout14","soft":10000,"hard":48000,"nativeStructured":false,"tier":"full","ok":true,"compacted":false,"fullBytes":5457,"finalBytes":5457,"sha256":"7d1d8efb0af37ddad87921600f04041e12c8a215be15e4fee2471984b7498035"},
  {"shape":"fanout14","soft":10000,"hard":48000,"nativeStructured":true,"tier":"full","ok":true,"compacted":false,"fullBytes":3507,"finalBytes":3507,"sha256":"2f6bd3af3268f2d8548fd47c3b9aa9f48a76201a5e8eb6ff51f7aa273f5a46dc"},
  {"shape":"fanout14","soft":1,"hard":100000,"nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":5457,"finalBytes":2854,"sha256":"a73ae75b76fc51a29cc0142c74e2aeaa77fb6ea3fc18c5e0ff47077bb36aa7b4"},
  {"shape":"fanout14","soft":1,"hard":100000,"nativeStructured":true,"tier":"names-only","ok":true,"compacted":true,"fullBytes":3507,"finalBytes":855,"sha256":"a0449b5a00bff0eaf1f67c691e03873438c65167945c573272af07e494ce8bac"},
  {"shape":"fanout16","nativeStructured":false,"tier":"full","ok":true,"compacted":false,"fullBytes":5959,"finalBytes":5959,"sha256":"7b01223997cb0f3a771be249b57407dfd1c0e48a34ddd3ad37409e4cbf000325"},
  {"shape":"fanout16","nativeStructured":true,"tier":"full","ok":true,"compacted":false,"fullBytes":4009,"finalBytes":4009,"sha256":"39eaaaf2bea3046f2e86975649929ba182e1879cf50cf7c9cdb035a78feccf6f"},
  {"shape":"fanout16","soft":10000,"hard":48000,"nativeStructured":false,"tier":"full","ok":true,"compacted":false,"fullBytes":5959,"finalBytes":5959,"sha256":"7b01223997cb0f3a771be249b57407dfd1c0e48a34ddd3ad37409e4cbf000325"},
  {"shape":"fanout16","soft":10000,"hard":48000,"nativeStructured":true,"tier":"full","ok":true,"compacted":false,"fullBytes":4009,"finalBytes":4009,"sha256":"39eaaaf2bea3046f2e86975649929ba182e1879cf50cf7c9cdb035a78feccf6f"},
  {"shape":"fanout16","soft":1,"hard":100000,"nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":5959,"finalBytes":2864,"sha256":"7d6e04d4fca026e810159966e65c0f82c64b513233a5541a3881848a72461bef"},
  {"shape":"fanout16","soft":1,"hard":100000,"nativeStructured":true,"tier":"names-only","ok":true,"compacted":true,"fullBytes":4009,"finalBytes":865,"sha256":"d1ecc8a83f2aa683262a0eb8fe851d7c359a41de62c3ee6721224bd2fda1b1f5"},
  {"shape":"nested_diamond12","nativeStructured":false,"tier":"skinny","ok":true,"compacted":true,"fullBytes":78257,"finalBytes":11714,"sha256":"fbe6aaeebf14212b22e187429a3e0f83318cf20bdeebae4361523ed3f1f228c6"},
  {"shape":"nested_diamond12","nativeStructured":true,"tier":"skinny","ok":true,"compacted":true,"fullBytes":76307,"finalBytes":9764,"sha256":"8ca20be3ddc248ec84d2c36c23f22b78702c3f729d89ba2a73d8d5713c2677a2"},
  {"shape":"nested_diamond12","soft":10000,"hard":48000,"nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":78257,"finalBytes":2854,"sha256":"0664a44f0afe68ac2c5c12f80f2123a310c9e1c68ce7f0bdca947433a3d1c0f4"},
  {"shape":"nested_diamond12","soft":10000,"hard":48000,"nativeStructured":true,"tier":"skinny","ok":true,"compacted":true,"fullBytes":76307,"finalBytes":9764,"sha256":"8ca20be3ddc248ec84d2c36c23f22b78702c3f729d89ba2a73d8d5713c2677a2"},
  {"shape":"nested_diamond12","soft":1,"hard":100000,"nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":78257,"finalBytes":2854,"sha256":"0664a44f0afe68ac2c5c12f80f2123a310c9e1c68ce7f0bdca947433a3d1c0f4"},
  {"shape":"nested_diamond12","soft":1,"hard":100000,"nativeStructured":true,"tier":"names-only","ok":true,"compacted":true,"fullBytes":76307,"finalBytes":855,"sha256":"f5ff9ede22467d4e71ad2037d31ce485f504e9ef8824702e7763f3b38d586387"},
  {"shape":"nested_diamond14","nativeStructured":false,"tier":"skinny","ok":true,"compacted":true,"fullBytes":78635,"finalBytes":11714,"sha256":"fbe6aaeebf14212b22e187429a3e0f83318cf20bdeebae4361523ed3f1f228c6"},
  {"shape":"nested_diamond14","nativeStructured":true,"tier":"skinny","ok":true,"compacted":true,"fullBytes":76685,"finalBytes":9764,"sha256":"8ca20be3ddc248ec84d2c36c23f22b78702c3f729d89ba2a73d8d5713c2677a2"},
  {"shape":"nested_diamond14","soft":10000,"hard":48000,"nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":78635,"finalBytes":2854,"sha256":"0664a44f0afe68ac2c5c12f80f2123a310c9e1c68ce7f0bdca947433a3d1c0f4"},
  {"shape":"nested_diamond14","soft":10000,"hard":48000,"nativeStructured":true,"tier":"skinny","ok":true,"compacted":true,"fullBytes":76685,"finalBytes":9764,"sha256":"8ca20be3ddc248ec84d2c36c23f22b78702c3f729d89ba2a73d8d5713c2677a2"},
  {"shape":"nested_diamond14","soft":1,"hard":100000,"nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":78635,"finalBytes":2854,"sha256":"0664a44f0afe68ac2c5c12f80f2123a310c9e1c68ce7f0bdca947433a3d1c0f4"},
  {"shape":"nested_diamond14","soft":1,"hard":100000,"nativeStructured":true,"tier":"names-only","ok":true,"compacted":true,"fullBytes":76685,"finalBytes":855,"sha256":"f5ff9ede22467d4e71ad2037d31ce485f504e9ef8824702e7763f3b38d586387"},
  {"shape":"unicode","nativeStructured":false,"tier":"full","ok":true,"compacted":false,"fullBytes":3169,"finalBytes":3169,"sha256":"cb7818882160a2d3746b24e0e252b0572fd9e49a81b591f96a9933e2ac3dd78d"},
  {"shape":"unicode","nativeStructured":true,"tier":"full","ok":true,"compacted":false,"fullBytes":1219,"finalBytes":1219,"sha256":"c3f830739376e65f9b810d1c86b40e11996000e383d064bef6f9eab7c6cf6997"},
  {"shape":"unicode","soft":10000,"hard":48000,"nativeStructured":false,"tier":"full","ok":true,"compacted":false,"fullBytes":3169,"finalBytes":3169,"sha256":"cb7818882160a2d3746b24e0e252b0572fd9e49a81b591f96a9933e2ac3dd78d"},
  {"shape":"unicode","soft":10000,"hard":48000,"nativeStructured":true,"tier":"full","ok":true,"compacted":false,"fullBytes":1219,"finalBytes":1219,"sha256":"c3f830739376e65f9b810d1c86b40e11996000e383d064bef6f9eab7c6cf6997"},
  {"shape":"unicode","soft":1,"hard":100000,"nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":3169,"finalBytes":2873,"sha256":"f0fab738446211a765b4d5686e74ae4801ef5251c26da68e626c8791f7816eee"},
  {"shape":"unicode","soft":1,"hard":100000,"nativeStructured":true,"tier":"names-only","ok":true,"compacted":true,"fullBytes":1219,"finalBytes":874,"sha256":"379dfcd8496c6d4b53e2bf294a7a194c788ff8189141be33c0e75152ec29edb7"},
  {"shape":"keyword_zoo","nativeStructured":false,"tier":"full","ok":true,"compacted":false,"fullBytes":4056,"finalBytes":4056,"sha256":"3c1f5d6df8499d5a878ec84228c8f9a936dae67693b393209063b59bc31064fb"},
  {"shape":"keyword_zoo","nativeStructured":true,"tier":"full","ok":true,"compacted":false,"fullBytes":2106,"finalBytes":2106,"sha256":"02c34b7400555d55251b9572c6c65b3ae187f857319e1dab1b9af8b6fb982214"},
  {"shape":"keyword_zoo","soft":10000,"hard":48000,"nativeStructured":false,"tier":"full","ok":true,"compacted":false,"fullBytes":4056,"finalBytes":4056,"sha256":"3c1f5d6df8499d5a878ec84228c8f9a936dae67693b393209063b59bc31064fb"},
  {"shape":"keyword_zoo","soft":10000,"hard":48000,"nativeStructured":true,"tier":"full","ok":true,"compacted":false,"fullBytes":2106,"finalBytes":2106,"sha256":"02c34b7400555d55251b9572c6c65b3ae187f857319e1dab1b9af8b6fb982214"},
  {"shape":"keyword_zoo","soft":1,"hard":100000,"nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":4056,"finalBytes":2850,"sha256":"fa1709989de399353d897ac674d7d31259a1157b03460c10bd09ad6d0b703f12"},
  {"shape":"keyword_zoo","soft":1,"hard":100000,"nativeStructured":true,"tier":"names-only","ok":true,"compacted":true,"fullBytes":2106,"finalBytes":851,"sha256":"4ea8c7eb32893aa6ea7233d811176f593d529bab91e8d82251c145aa6da35661"},
  {"shape":"malformed","nativeStructured":false,"tier":"full","ok":true,"compacted":false,"fullBytes":3304,"finalBytes":3304,"sha256":"2658ae9c46f60a5dc7586ad940a6e92e1ca08c70576d8cc646b6929f6f0f5a48"},
  {"shape":"malformed","nativeStructured":true,"tier":"full","ok":true,"compacted":false,"fullBytes":1354,"finalBytes":1354,"sha256":"658dc8cb8428101d50c857e3a30385c49cfc6b62ae701b4438d1e16e3c70a87a"},
  {"shape":"malformed","soft":10000,"hard":48000,"nativeStructured":false,"tier":"full","ok":true,"compacted":false,"fullBytes":3304,"finalBytes":3304,"sha256":"2658ae9c46f60a5dc7586ad940a6e92e1ca08c70576d8cc646b6929f6f0f5a48"},
  {"shape":"malformed","soft":10000,"hard":48000,"nativeStructured":true,"tier":"full","ok":true,"compacted":false,"fullBytes":1354,"finalBytes":1354,"sha256":"658dc8cb8428101d50c857e3a30385c49cfc6b62ae701b4438d1e16e3c70a87a"},
  {"shape":"malformed","soft":1,"hard":100000,"nativeStructured":false,"tier":"names-only","ok":true,"compacted":true,"fullBytes":3304,"finalBytes":2920,"sha256":"ba3c3a08049a7740bd522b7570f6af807b8c756a76c077527f5bfc623e78526c"},
  {"shape":"malformed","soft":1,"hard":100000,"nativeStructured":true,"tier":"names-only","ok":true,"compacted":true,"fullBytes":1354,"finalBytes":921,"sha256":"c9c5774a40056b8454698172a38e1267d8462af9e311ba7e7f5128e6d1632875"},
];

test('tier ladder: tier, byte counts and shipped preamble bytes are unchanged', () => {
  withDefaultCaps(() => {
    for (const g of GOLDENS) {
      const tools = SHAPES[g.shape]();
      const opts = { modelKey: 'claude-sonnet-4.6', route: 'chat' };
      if (g.soft !== undefined) opts.softBytes = g.soft;
      if (g.hard !== undefined) opts.hardBytes = g.hard;
      if (g.nativeStructured) opts.nativeStructured = true;
      const r = applyToolPreambleBudget(tools, 'auto', 'cwd: D:/w', opts);
      const where = `${g.shape} soft=${g.soft ?? 'default'} hard=${g.hard ?? 'default'} native=${g.nativeStructured}`;
      assert.equal(r.tier, g.tier, `${where}: tier changed`);
      assert.equal(r.ok, g.ok, `${where}: ok changed`);
      assert.equal(r.compacted, g.compacted, `${where}: compacted changed`);
      assert.equal(r.fullBytes, g.fullBytes, `${where}: fullBytes changed`);
      assert.equal(r.finalBytes, g.finalBytes, `${where}: finalBytes changed (shipped size)`);
      const sha = createHash('sha256').update(r.preamble).digest('hex');
      assert.equal(sha, g.sha256, `${where}: the shipped preamble bytes changed`);
    }
  });
});

test('tier ladder: a discarded tier is never the one that ships', () => {
  // The property the optimization relies on: any tier that exceeds the soft cap is
  // overwritten by a later tier before the result is returned, so its CONTENT is
  // unobservable. Pin it rather than assume it.
  const tools = SHAPES.tools56();
  const r = applyToolPreambleBudget(tools, 'auto', '', { modelKey: 'claude-sonnet-4.6', route: 'chat', softBytes: 24000, hardBytes: 48000 });
  assert.equal(r.compacted, true);
  assert.notEqual(r.tier, 'full');
  assert.ok(r.finalBytes <= 24000, 'the shipped tier must fit the soft cap');
  assert.ok(r.fullBytes > 24000, 'the discarded full tier must be the larger one');
  assert.ok(Buffer.byteLength(r.preamble, 'utf8') === r.finalBytes);
  assert.equal(injectPreambleIntoSystemPrompt([], r.preamble).length, 1);
});

// ─── the bounded walk must not be observable at all ────────────────────────
// applyToolPreambleBudget asks the schema-compact builder to stop once the inliner
// has PROVEN more bytes than that tier could ever be accepted with. Everything above
// pins the shipped bytes of the ordinary path; this section pins the property the
// speed-up rests on: dropping the walk early changes NOTHING that can be observed,
// and the truncation itself can never reach `preamble`.
//
// Both sides of every comparison below use the same three arguments the goldens use
// (`callerEnv = 'cwd: D:/w'`, modelKey `claude-sonnet-4.6`, route `chat`): the
// preamble tiers are not length-neutral in any of them (calling the ladder with an
// EMPTY callerEnv moves tools2000x1 by 470 bytes), so a comparison that varied one
// would measure the argument, not the change.
const ENV_ARG = 'cwd: D:/w';
const MODEL_ARG = 'claude-sonnet-4.6';

/** Every tier built with NO byte bound — i.e. what the ladder did before the bound. */
function ladderUnbounded(tools, opts = {}) {
  const softBytes = opts.softBytes ?? parseInt(process.env.TOOL_PREAMBLE_SOFT_BYTES || '24000', 10);
  const hardBytes = opts.hardBytes ?? parseInt(process.env.TOOL_PREAMBLE_HARD_BYTES || '48000', 10);
  const tierOpts = opts.nativeStructured ? { nativeStructured: true } : {};
  const args = [tools, 'auto', ENV_ARG, opts.modelKey || null, opts.provider || null, opts.route || null, tierOpts];
  const tiers = [
    ['full', () => buildToolPreambleForProto(...args)],
    ['schema-compact', () => buildSchemaCompactToolPreambleForProto(...args)],
    ['skinny', () => buildSkinnyToolPreambleForProto(...args)],
    ['names-only', () => buildCompactToolPreambleForProto(...args)],
  ];
  const full = tiers[0][1]();
  if (!full) return { ok: true, preamble: '', fullBytes: 0, finalBytes: 0, compacted: false, tier: 'empty' };
  let chosen = { tier: 'full', preamble: full, bytes: Buffer.byteLength(full, 'utf8') };
  for (const [tier, build] of tiers) {
    const text = tier === 'full' ? full : build();
    const bytes = Buffer.byteLength(text, 'utf8');
    chosen = { tier, preamble: text, bytes };
    if (bytes <= softBytes) break;
  }
  const compacted = chosen.tier !== 'full';
  return { ok: chosen.bytes <= hardBytes, preamble: chosen.preamble, fullBytes: Buffer.byteLength(full, 'utf8'), finalBytes: chosen.bytes, compacted, tier: chosen.tier };
}

/** The shipped result hashed: everything the request path can observe. */
function fingerprint(r) {
  return JSON.stringify({
    tier: r.tier, ok: r.ok, compacted: r.compacted, fullBytes: r.fullBytes, finalBytes: r.finalBytes,
    sha256: createHash('sha256').update(r.preamble).digest('hex'),
  });
}

const ladderOpts = (extra = {}) => ({ modelKey: MODEL_ARG, route: 'chat', ...extra });

test('bounded walk: the result is byte-identical to an unbounded ladder, on every golden setting', () => {
  withDefaultCaps(() => {
    for (const g of GOLDENS) {
      const tools = SHAPES[g.shape]();
      const opts = ladderOpts();
      if (g.soft !== undefined) opts.softBytes = g.soft;
      if (g.hard !== undefined) opts.hardBytes = g.hard;
      if (g.nativeStructured) opts.nativeStructured = true;
      const bounded = applyToolPreambleBudget(tools, 'auto', ENV_ARG, opts);
      const unbounded = ladderUnbounded(tools, opts);
      const where = `${g.shape} soft=${g.soft ?? 'default'} hard=${g.hard ?? 'default'} native=${g.nativeStructured}`;
      assert.equal(fingerprint(bounded), fingerprint(unbounded),
        `${where}: bounding the schema-compact walk changed an observable`);
      // And the dropped tier can never be what shipped.
      assert.equal(Buffer.byteLength(bounded.preamble, 'utf8'), bounded.finalBytes, `${where}: preamble length`);
    }
  });
});

test('bounded walk: an aborted tier is dropped, never shipped as its own truncated prefix', () => {
  // The 14-level diamond builds to ~1 MB canonical and is rejected by both caps. The
  // walk now stops after ~2.7 KB, and that prefix fits the soft cap — so a ladder
  // that measured it would ACCEPT and ship a preamble whose schemas are placeholders.
  // This is the regression the drop signal exists for: assert the tier, not the prefix.
  const tools = SHAPES.nested_diamond14();
  const r = applyToolPreambleBudget(tools, 'auto', ENV_ARG, ladderOpts());
  assert.equal(r.tier, 'skinny', 'the diamond must still fall through to skinny');
  assert.equal(r.finalBytes, 11714, 'skinny tier size for this shape is pinned by the goldens');
  assert.equal(r.preamble.includes('Params: {"type":"object"}'), false,
    'the truncated schema-compact prefix leaked into the shipped preamble');
  assert.equal(r.preamble.includes('field_path'), false, 'sanity: the diamond has no such parameter');
  assert.ok(r.preamble.includes('Sig') || r.preamble.includes('root'), 'the shipped skinny tier must be the real one');
  assert.equal(fingerprint(r), fingerprint(ladderUnbounded(tools, ladderOpts())));
});

test('bounded walk: the cap it stops at is the caller\'s own cap, not a hardcoded default', () => {
  // The abort bound is min(soft, hard), so it must NOT fire whenever a caller's caps
  // leave the schema-compact tier acceptable: tools25's canonical compact tier is
  // 22,829 B and its full tier is 129,654 B, so caps of 50 KB/60 KB reject `full` and
  // must let schema-compact be built in full and SHIP. A bound hardcoded to the 24,000
  // default would still build this one, but a bound derived from the WRONG cap (the
  // 24,000 soft default instead of the caller's) is what the rest of this test pins.
  const tools = SHAPES.tools25();
  const opts = ladderOpts({ softBytes: 50_000, hardBytes: 60_000 });
  const r = applyToolPreambleBudget(tools, 'auto', ENV_ARG, opts);
  assert.equal(r.tier, 'schema-compact', 'a caller whose caps accept the tier must not have it aborted');
  assert.equal(r.finalBytes, 22829, 'the full 22,829 B compact tier must be built, not a prefix');
  assert.equal(r.ok, true);
  assert.equal(fingerprint(r), fingerprint(ladderUnbounded(tools, opts)));
  // Same shape, caps that are high enough to accept everything: `full` wins, and the
  // bound (1 MB) is far above it, so nothing is pruned.
  const huge = ladderOpts({ softBytes: 1_000_000, hardBytes: 2_000_000 });
  assert.equal(fingerprint(applyToolPreambleBudget(tools, 'auto', ENV_ARG, huge)),
    fingerprint(ladderUnbounded(tools, huge)));
  // A DIAMOND: 78 KB full, ~439 KB compact. Under `huge` the FULL tier is accepted;
  // under the defaults the compact tier is rejected and it drops to skinny. Both must
  // match the unbounded ladder.
  const diamond = SHAPES.nested_diamond12();
  const tight = applyToolPreambleBudget(diamond, 'auto', ENV_ARG, ladderOpts());
  assert.equal(tight.tier, 'skinny');
  assert.equal(fingerprint(applyToolPreambleBudget(diamond, 'auto', ENV_ARG, huge)), fingerprint(ladderUnbounded(diamond, huge)));
  // soft == hard is min()'s tightest case: rejected at exactly the cap.
  const equal = ladderOpts({ softBytes: 40_000, hardBytes: 40_000 });
  assert.equal(fingerprint(applyToolPreambleBudget(diamond, 'auto', ENV_ARG, equal)),
    fingerprint(ladderUnbounded(diamond, equal)));
  // Every cap split the fixtures exercise — including soft > hard, where the bound has
  // to be the SMALLER cap or a rejected tier would be built in full — agrees.
  for (const caps of [{ softBytes: 1, hardBytes: 100_000 }, { softBytes: 10_000, hardBytes: 48_000 }, { softBytes: 48_000, hardBytes: 10_000 }]) {
    for (const shape of ['tools25', 'nested_diamond12']) {
      const o = ladderOpts(caps);
      assert.equal(fingerprint(applyToolPreambleBudget(SHAPES[shape](), 'auto', ENV_ARG, o)),
        fingerprint(ladderUnbounded(SHAPES[shape](), o)),
        `${shape} caps ${JSON.stringify(caps)} disagreed with the unbounded ladder`);
    }
  }
});

test('bounded walk: when the tier is dropped, the ladder still reports the tier it would have rejected', () => {
  // 2000 tools x 1 property: names-only is 31 KB, over the 1500 B hard cap, so the
  // request must be REJECTED. The compact tier is dropped on the way, and `chosen`
  // has to end up on names-only (the tier the unbounded ladder reports) rather than
  // on the dropped one or on whatever was chosen before it.
  const tools = SHAPES.tools2000x1();
  const opts = ladderOpts({ softBytes: 1_000, hardBytes: 1_500 });
  const r = applyToolPreambleBudget(tools, 'auto', ENV_ARG, opts);
  assert.equal(r.ok, false, 'this shape must still be rejected');
  assert.equal(r.tier, 'names-only');
  assert.ok(r.finalBytes > 1_500);
  assert.equal(fingerprint(r), fingerprint(ladderUnbounded(tools, opts)));
});

test('bounded walk: the diagnostic still fires for the shape that used to burn the node budget', () => {
  const capture = () => {
    const warns = [];
    const original = log.warn;
    log.warn = (...args) => { warns.push(args.join(' ')); };
    try { return { warns, r: applyToolPreambleBudget(SHAPES.nested_diamond14(), 'auto', ENV_ARG, ladderOpts()) }; }
    finally { log.warn = original; }
  };
  // The ladder asks the builder to stop at its cap, so this is the cap-stop arm of
  // the warning: one line, naming the offending tool and the node budget constant.
  const { warns } = capture();
  assert.equal(warns.length, 1, `expected exactly one warning, got ${warns.length}: ${warns.join(' | ')}`);
  assert.match(warns[0], /TOOL_PREAMBLE: \$ref inlining hit the 50000-node budget/);
  assert.match(warns[0], /first exhausted at tool "diamond"/);
  assert.equal(/Innocent/.test(warns[0]), false);
  // Called with NO byte bound (a direct caller), the same shape still exhausts the
  // NODE budget instead — that arm must keep its original text, unchanged.
  const warns2 = [];
  const original = log.warn;
  log.warn = (...args) => { warns2.push(args.join(' ')); };
  try {
    buildSchemaCompactToolPreambleForProto(SHAPES.nested_diamond14(), 'auto', '', 'claude-sonnet-4.6', null, 'chat', {});
  } finally { log.warn = original; }
  assert.deepEqual(warns2, [
    'TOOL_PREAMBLE: $ref inlining hit the 50000-node budget (first exhausted at tool "diamond", 1 tool(s));'
    + ' the remaining subtrees were emitted as {"type":"object"} placeholders.'
    + ' A $ref repeated in sibling positions fans out multiplicatively — look for a'
    + ' diamond in that schema rather than for a cycle.',
  ], 'the node-budget warning text changed for direct callers');
});

// ─── the optimization must still be present (revert/erode detection) ───────
test('bounded walk: the cost bound is still wired from the caller\'s caps', () => {
  // The byte bound is deliberately UNOBSERVABLE in the response, so the behavioural
  // tests above cannot notice it being unhooked — they assert the two paths agree,
  // which they do even if the builder never receives a cap. Measured: with the bound
  // removed the whole file still passes. These are the assertions that keep the
  // optimization itself on the hook, one per way it can be silently disabled.
  const chat = readFileSync(new URL('../src/handlers/chat.js', import.meta.url), 'utf8');
  const emu = readFileSync(new URL('../src/handlers/tool-emulation.js', import.meta.url), 'utf8');

  // The bound is DERIVED from the two caps in this function, not a constant: minimum,
  // because rejection is certain past EITHER cap and the builder prunes what it
  // returns. `max`, `24000` or any hardcoded literal would move goldens at
  // soft/hard = 1/100000 and 10000/48000.
  assert.ok(/const abortAtBytes = Math\.min\(softBytes, hardBytes\);/.test(chat),
    'the abort bound must be min(softBytes, hardBytes), derived in applyToolPreambleBudget');
  assert.equal(/const abortAtBytes = (?!Math\.min\(softBytes, hardBytes\))/.test(chat), false,
    'exactly one abortAtBytes definition, and it must read both caps');
  // ...and it must actually reach the builder, through the per-tier opts.
  assert.ok(/\{ \.\.\.tierOpts, \.\.\.t\.opts \}/.test(chat),
    'the per-tier opts must be spread into the builder call, or the cap never arrives');
  assert.ok(/opts: \{ abortAtBytes \}/.test(chat),
    'the schema-compact tier must be the one carrying the abort bound');

  // The builder installs it on the budget and compares with `>`, strictly: `>=` would
  // stop a walk at exactly the cap, where the finished tier still fits.
  assert.ok(/if \(budget\.byteLimit === undefined\) budget\.byteLimit = opts\.abortAtBytes;/.test(emu),
    'the builder must install the caller\'s cap on the budget');
  assert.ok(/budget\.byteLimit !== undefined && budget\.bytes > budget\.byteLimit/.test(emu),
    'the cap check must be `>`, and only when a cap was supplied');
  // The counter that makes the check mean anything, and the floor it is charged at.
  assert.ok(/budget\.bytes \+= SCHEMA_INLINE_MIN_NODE_BYTES;/.test(emu),
    'the per-node floor must still be charged, or the byte bound can never bind');
  assert.ok(/budget\.bytes \+= k\.length \+ 5;/.test(emu),
    'the per-key floor must still be charged');
  assert.ok(/const SCHEMA_INLINE_MIN_NODE_BYTES = 2;/.test(emu),
    'the per-node floor is 2 B (the `{}`), which is what makes the counter a LOWER bound; '
    + 'raising it over-counts and can drop a tier that still fits');
  // The stop must be reported to the caller instead of being returned as content.
  assert.ok(/if \(budget\.stoppedByCap && opts\.abortAtBytes !== undefined\) throw new SchemaCompactTierDropped\(\);/.test(emu),
    'a cap-stopped build must throw the drop signal, never return its prefix');
  assert.ok(/isTierOverBudgetSignal\(err\)/.test(chat),
    'the ladder must drop the tier the builder reported as over budget');
  // And the diagnostic must still explain WHICH limit stopped it (the ternary alone is
  // not enough: an empty arm keeps the shape and loses the explanation).
  assert.ok(/budget\.stoppedByCap\s*\n\s*\?/.test(emu),
    'the warning must keep its cap-stop arm, or an operator cannot tell the two apart');
  assert.ok(/already proven more than the preamble byte cap/.test(emu),
    'the cap-stop arm must still say WHY it stopped');
  assert.ok(/the rest of that tier is pruned before it is built/.test(emu),
    'the cap-stop arm must still say what happened to the rest of the tier');
});

test('schema-compact inliner: the per-node cost reductions are still in place', () => {
  const SRC = readFileSync(new URL('../src/handlers/tool-emulation.js', import.meta.url), 'utf8');
  // assert.ok() rather than assert.match(): a failure here must print the missing
  // pattern, not the whole 100 KB module.
  // One hoisted Set for the whole module instead of one per schema node.
  assert.ok(/const SCHEMA_KEEP_KEYS = new Set\(\[/.test(SRC),
    'the KEEP set must be hoisted out of stripSchemaDocs (per-node Set allocation)');
  assert.equal((SRC.match(/new Set\(\['type', 'enum'/g) || []).length, 1,
    'exactly one KEEP set literal may exist in the module');
  // $ref resolution memoised per build instead of re-walked on every visit.
  assert.ok(/resolveRefCached\(ref, root, budget\)/.test(SRC),
    'stripSchemaDocs must resolve $refs through the per-build cache');
  assert.ok(/resolveRefCached\(ref, root, budget\)[\s\S]{0,400}?resolveLocalSchemaRef\(ref, root\)/.test(SRC),
    'the cache must be the only path to resolveLocalSchemaRef');
  // Key iteration without the [key, value] pair arrays Object.entries allocates.
  assert.ok(/for \(const k of Object\.keys\(schema\)\)/.test(SRC),
    'stripSchemaDocs must iterate keys, not Object.entries pairs');
  assert.equal((SRC.match(/for \(const \[k, v\] of Object\.entries\(schema\)\)/g) || []).length, 0,
    'no Object.entries(schema) pair-array loop may remain in the module');
});
