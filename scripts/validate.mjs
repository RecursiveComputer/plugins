#!/usr/bin/env node
/**
 * Checks every plugin under plugins/ before it can ship:
 *
 * - plugin.json is valid, its id matches the folder, and it is not private;
 * - code imports only npm packages, its own files and @recursivecomputer/plugin-sdk
 *   (Recursive's internal @recursive/* packages are not published);
 * - a plugin using an SDK value that needs a newer Recursive declares that host API;
 * - package.json workspaces list every plugin that has a package.json.
 *
 *   node scripts/validate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = /\.(?:[cm]?[jt]sx?|svelte)$/;
const SKIP = new Set(['node_modules', 'dist', '.prebuilt-ui', '.git']);
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\(\s*|^\s*import\s+)(['"])([^'"\n]+)\1/gm;
const ALLOWED_SCOPED = new Set(['@recursivecomputer/plugin-sdk']);

/**
 * SDK runtime values that Recursive serves from host API 2 on (SDK 0.2.0). Mirrors
 * SDK_VALUES_SINCE_HOST_API_2 in the Recursive repository.
 */
export const SDK_VALUES_SINCE_HOST_API_2 = new Set([
  'DEFAULT_CLASSIFICATION_TIMEOUT_MS', 'DEFAULT_COMPACTION_TIMEOUT_MS', 'MAX_CLASSIFICATION_TIMEOUT_MS',
  'PLUGIN_ACCOUNT_ARGUMENT', 'buildClassificationQuestions', 'canonicalConversationKey', 'classificationState',
  'describePluginAccounts', 'executionSkillMode', 'isReactionName', 'normalizeReactionEmoji',
  'persistPluginAccountPatch', 'resolvePluginAccount', 'selectPluginAccountSettings', 'serverTailnetHostname',
  'tailnetUserData', 'toolErrorFromUnknown', 'toolFailure',
]);

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // A nested package (for example a Cloudflare worker) builds on its own.
      if (fs.existsSync(path.join(full, 'package.json'))) continue;
      sourceFiles(full, out);
    } else if (SOURCE.test(entry.name)) out.push(full);
  }
  return out;
}

function hostApiMin(manifest) {
  const range = manifest.engines?.recursive?.hostApi;
  if (typeof range !== 'string') return 1;
  const min = /(?:^|>=|\s|\^)(\d+)/.exec(range.trim());
  return min ? Number(min[1]) : 1;
}

export function checkImports(pluginDir, files = sourceFiles(pluginDir)) {
  const problems = [];
  const sdkValues = new Set();
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT)) {
      const spec = match[2];
      if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(file), spec);
        if (target !== pluginDir && !target.startsWith(pluginDir + path.sep)) {
          problems.push(`${rel}: ${spec} reaches outside the plugin`);
        }
      } else if (spec.startsWith('@recursive/')) {
        problems.push(`${rel}: ${spec} is internal to Recursive; use @recursivecomputer/plugin-sdk`);
      } else if (spec.startsWith('@recursivecomputer/') && !ALLOWED_SCOPED.has(spec.split('/').slice(0, 2).join('/'))) {
        problems.push(`${rel}: ${spec} is not published`);
      }
    }
    for (const match of text.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*['"]@recursivecomputer\/plugin-sdk['"]/g)) {
      for (const element of match[1].split(',')) {
        const name = element.trim().split(/\s+as\s+/)[0];
        if (SDK_VALUES_SINCE_HOST_API_2.has(name)) sdkValues.add(name);
      }
    }
  }
  return { problems, sdkValues: [...sdkValues].sort() };
}

export async function validate(root = ROOT) {
  const { validatePluginManifest } = await import('@recursivecomputer/plugin-sdk');
  const pluginsDir = path.join(root, 'plugins');
  const problems = [];
  const withPackage = [];
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(pluginsDir, entry.name);
    const where = `plugins/${entry.name}`;
    const manifestFile = path.join(dir, 'plugin.json');
    if (!fs.existsSync(manifestFile)) {
      problems.push(`${where}: missing plugin.json`);
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    } catch (error) {
      problems.push(`${where}/plugin.json: ${error.message}`);
      continue;
    }
    const { errors } = validatePluginManifest(manifest);
    for (const error of errors) problems.push(`${where}/plugin.json: ${error}`);
    if (manifest.id !== entry.name) problems.push(`${where}/plugin.json: id "${manifest.id}" must match the folder name`);
    if (manifest.private === true) problems.push(`${where}/plugin.json: private plugins do not belong in this repository`);
    const imports = checkImports(dir);
    problems.push(...imports.problems);
    if (imports.sdkValues.length && hostApiMin(manifest) < 2) {
      problems.push(`${where}/plugin.json: uses ${imports.sdkValues.join(', ')}; add "engines": { "recursive": { "hostApi": "2" } }`);
    }
    if (fs.existsSync(path.join(dir, 'package.json'))) withPackage.push(where);
  }
  const workspaces = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).workspaces ?? [];
  for (const where of withPackage) if (!workspaces.includes(where)) problems.push(`package.json: add "${where}" to workspaces`);
  for (const where of workspaces) if (!withPackage.includes(where)) problems.push(`package.json: workspace "${where}" has no package.json`);
  return problems.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const problems = await validate();
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log('All plugins valid.');
}
