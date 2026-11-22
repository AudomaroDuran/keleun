// UAT de la instalación: lo que haría alguien que recibe el instalador, de punta a punta, sin Node en su computadora.
//   1. Instala en silencio (por usuario) y revisa la carpeta, los accesos directos y el desinstalador.
//   2. Abre la app instalada con un PATH sin Node, sobre un proyecto nuevo (un repo de Git con código), y pulsa
//      «Preparar con keleun» en el diálogo nativo (UI Automation).
//   3. Revisa lo que preparó: docs/, los comandos keleun y bitacora, el PATH del usuario, los hooks y el MCP de Claude Code.
//   4. Claude Code (de la terminal, sin Node) usa el MCP y el comando bitacora; los hooks corren; el Puente lo muestra solo.
//   5. Conversación desde la app instalada: responde.
//   6. Cierra la app (sin procesos colgados) y desinstala (no quedan la carpeta ni los accesos directos).
// Usa un instalador con otro identificador (keleun UAT) para no tocar el keleun instalado de la persona:
//   npx electron-builder --win -c.appId=ai.keleun.uat "-c.productName=keleun UAT" -c.directories.output=dist-uat "-c.nsis.shortcutName=keleun UAT"
//   node scripts/uat-install.ts [dist-uat/keleun-0.9.0-setup.exe] [carpeta de salida]
// Cuesta unos centavos de uso de Claude (dos respuestas cortas con Haiku).
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const REPO = resolve(import.meta.dirname, '..');
const SETUP = resolve(process.argv[2] ?? join(REPO, 'dist-uat', 'keleun-0.9.0-setup.exe'));
const OUT = resolve(process.argv[3] ?? join(tmpdir(), 'keleun-uat'));
mkdirSync(OUT, { recursive: true });
// UAT_APP_NAME: «keleun» para probar el instalador real en una máquina limpia (p. ej. un runner de GitHub Actions).
const NAME = process.env.UAT_APP_NAME ?? 'keleun UAT';
// UAT_NO_CLAUDE_LOGIN=1: máquina sin cuenta de Claude. Se prueba el registro con el comando keleun (sin Node) y los
// hooks directamente, y se omite la conversación (necesita una cuenta).
const NO_LOGIN = !!process.env.UAT_NO_CLAUDE_LOGIN;
const LOCAL = process.env.LOCALAPPDATA!;
const INSTALL = join(LOCAL, 'Programs', NAME);
const EXE = join(INSTALL, `${NAME}.exe`);
const work = mkdtempSync(join(tmpdir(), 'keleun-uat-'));
const BIN = join(work, 'bin');
const PROJECT = join(work, 'tienda-de-un-amigo');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: { step: string; ok: boolean; detail: string }[] = [];
async function step(name: string, fn: () => Promise<string | void> | string | void) {
  const t0 = Date.now();
  try {
    const d = (await fn()) ?? '';
    results.push({ step: name, ok: true, detail: d });
    console.log(`  ✓ ${name}${d ? ` · ${d}` : ''} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    results.push({ step: name, ok: false, detail: (e as Error).message });
    console.log(`  ✗ ${name}: ${(e as Error).message}`);
  }
}
const ps = (cmd: string) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' }).trim();
const userPath = () => ps("[Environment]::GetEnvironmentVariable('Path','User')");

// Un amigo sin Node: el PATH sin las carpetas de Node, npm ni nvm (Claude Code y Git sí, como pide la guía).
const NO_NODE_PATH = (process.env.PATH ?? '').split(delimiter).filter((d) => d && !/nodejs|nvm|npm|\\node\\?$|volta|fnm/i.test(d) && !existsSync(join(d, 'node.exe'))).join(delimiter);
const personEnv = (extra: Record<string, string> = {}) => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDECODE|CLAUDE_CODE_|BITACORA_|KELEUN_|CAIRN_|ELECTRON_)/.test(k)) env[k] = v;
  return { ...env, PATH: NO_NODE_PATH, ...extra };
};

let app: ReturnType<typeof spawn> | undefined;
let page: Page | undefined;
const pathBefore = userPath();

try {
  console.log(`UAT · ${SETUP}\n  trabajo: ${work}`);
  await step('sin Node en el PATH de prueba (como la computadora de un amigo)', () => {
    const r = spawnSync('where', ['node'], { env: personEnv(), encoding: 'utf8' });
    if (r.status === 0) throw new Error(`todavía se encuentra node: ${r.stdout.trim()}`);
    const c = spawnSync('where', ['claude'], { env: personEnv(), encoding: 'utf8' });
    if (c.status !== 0) throw new Error('Claude Code no está en el PATH (la guía pide instalarlo)');
    return `claude: ${c.stdout.trim().split(/\r?\n/)[0]}`;
  });

  await step('instalación silenciosa por usuario', () => {
    if (!existsSync(SETUP)) throw new Error(`no existe ${SETUP}`);
    const r = spawnSync(SETUP, ['/S'], { stdio: 'ignore', timeout: 180000 });
    if (r.status !== 0) throw new Error(`el instalador salió con ${r.status}`);
    if (!existsSync(EXE)) throw new Error(`no quedó ${EXE}`);
    const uninstaller = readdirSync(INSTALL).find((f) => /^Uninstall/i.test(f));
    if (!uninstaller) throw new Error('sin desinstalador');
    const menu = join(process.env.APPDATA!, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${NAME}.lnk`);
    if (!existsSync(menu)) throw new Error('sin acceso directo en el menú Inicio');
    const desktop = ps("[Environment]::GetFolderPath('Desktop')");
    if (!existsSync(join(desktop, `${NAME}.lnk`))) throw new Error('sin acceso directo en el escritorio');
    return `${INSTALL} · menú Inicio y escritorio`;
  });

  // Un proyecto de código que el amigo ya tiene: un repo de Git con un par de archivos.
  mkdirSync(join(PROJECT, 'src'), { recursive: true });
  writeFileSync(join(PROJECT, 'README.md'), '# Tienda\n\nTienda en línea pequeña.\n');
  writeFileSync(join(PROJECT, 'src', 'index.js'), "console.log('hola');\n");
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: PROJECT });

  const port = 9600 + Math.floor(Math.random() * 300);
  await step('abrir la app instalada sobre el proyecto y pulsar «Preparar con keleun»', async () => {
    app = spawn(EXE, [`--remote-debugging-port=${port}`, '--project', PROJECT], {
      // Datos propios: el nombre interno de la app es «keleun»; si la persona tiene su keleun abierto, compartirían el
      // candado de instancia única y esta se cerraría. En la computadora de un amigo no hace falta.
      env: personEnv({ KELEUN_BIN_DIR: BIN, CAIRN_DESKTOP_USERDATA: join(work, 'userdata') }), detached: true, stdio: 'ignore',
    });
    app.unref();
    // El diálogo es un TaskDialog: su botón («command link») no expone patrones de UI Automation. Como es el botón por
    // omisión, se trae la ventana al frente, se le da el foco y se pulsa Enter (lo que haría una persona con el teclado).
    const clicked = ps(`Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class KF { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }
"@
$root=[Windows.Automation.AutomationElement]::RootElement
$cond=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,'Preparar con keleun')
$r='no'
for($i=0;$i -lt 60;$i++){ $b=$root.FindFirst([Windows.Automation.TreeScope]::Descendants,$cond); if($b){ break }; Start-Sleep -Milliseconds 500 }
if($b){
  $w=[Windows.Automation.TreeWalker]::ControlViewWalker; $top=$b; while ($w.GetParent($top) -and $w.GetParent($top) -ne $root) { $top=$w.GetParent($top) }
  [KF]::SetForegroundWindow([IntPtr]$top.Current.NativeWindowHandle) | Out-Null
  $b.SetFocus(); [System.Windows.Forms.SendKeys]::SendWait('{ENTER}'); $r='ok'
}
$r`);
    if (clicked !== 'ok') throw new Error('no apareció el diálogo «Preparar con keleun»');
    for (let i = 0; i < 60 && !page; i++) {
      try {
        const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 });
        page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('http://127.0.0.1'));
      } catch { /* todavía no */ }
      if (!page) await sleep(500);
    }
    if (!page) throw new Error('la app no abrió la plataforma');
    await page.locator('.route-strip, .rs-empty').first().waitFor({ timeout: 20000 });
    await page.screenshot({ path: join(OUT, '1-puente-proyecto-nuevo.png') });
    return page.url().split('?')[0];
  });

  await step('lo que preparó: docs, comandos keleun y bitacora, hooks y skill', async () => {
    for (const f of ['bitacora.config.json', 'docs', 'AGENTS.md', '.claude/settings.local.json', '.claude/skills/bitacora/SKILL.md']) {
      if (!existsSync(join(PROJECT, f))) throw new Error(`falta ${f}`);
    }
    for (const f of ['keleun.cmd', 'bitacora.cmd', 'keleun', 'bitacora']) if (!existsSync(join(BIN, f))) throw new Error(`falta el comando ${f}`);
    const hooks = JSON.parse(readFileSync(join(PROJECT, '.claude', 'settings.local.json'), 'utf8')).hooks;
    const cmd: string = hooks.SessionStart[0].hooks[0].command;
    if (!cmd.includes('keleun.cmd') || /\bnode\b/.test(cmd)) throw new Error(`hook inesperado: ${cmd}`);
    const v = spawnSync(join(BIN, 'keleun.cmd'), ['roadmap'], { cwd: PROJECT, env: personEnv(), encoding: 'utf8', shell: true });
    if (v.status !== 0) throw new Error(`keleun roadmap falló: ${v.stderr || v.stdout}`);
    return `hook: ${cmd.slice(0, 70)}…`;
  });

  await step('el PATH del usuario tiene los comandos (para Claude Code desde la terminal)', async () => {
    for (let i = 0; i < 20; i++) { if (userPath().split(';').includes(BIN)) return BIN; await sleep(500); }
    throw new Error('la carpeta de comandos no quedó en el PATH del usuario');
  });

  await step('Claude Code conectado al servidor MCP con keleun.exe (sin Node)', async () => {
    for (let i = 0; i < 20; i++) {
      const r = spawnSync('claude', ['mcp', 'get', 'bitacora'], { cwd: PROJECT, env: personEnv(), encoding: 'utf8', shell: true });
      if (/Connected|Conectado/i.test(r.stdout) && r.stdout.includes(`${NAME}.exe`)) return r.stdout.split(/\r?\n/).find((l) => /Status/i.test(l))?.trim() ?? 'conectado';
      await sleep(1000);
    }
    const r = spawnSync('claude', ['mcp', 'get', 'bitacora'], { cwd: PROJECT, env: personEnv(), encoding: 'utf8', shell: true });
    throw new Error(`sin conexión: ${r.stdout || r.stderr}`);
  });

  if (NO_LOGIN) await step('sin cuenta de Claude: el comando keleun registra (sin Node) y el hook de inicio de sesión responde', async () => {
    const env = personEnv({ PATH: `${BIN}${delimiter}${NO_NODE_PATH}` });
    const log = spawnSync('keleun', ['log', '--item', 'OVW-PROJECT', '--kind', 'note', '--summary', '"Prueba UAT desde Claude Code"'], { cwd: PROJECT, env, encoding: 'utf8', shell: true });
    if (log.status !== 0) throw new Error(`keleun log falló: ${log.stderr || log.stdout}`);
    const hooks = JSON.parse(readFileSync(join(PROJECT, '.claude', 'settings.local.json'), 'utf8')).hooks;
    const cmd: string = hooks.SessionStart[0].hooks[0].command;
    const h = spawnSync(cmd, { cwd: PROJECT, env, encoding: 'utf8', shell: true, input: JSON.stringify({ session_id: '00000000-0000-4000-8000-000000000001', cwd: PROJECT, hook_event_name: 'SessionStart', source: 'startup' }) });
    if (h.status !== 0 || !/keleun|Bit[aá]cora|bitacora/i.test(h.stdout)) throw new Error(`el hook no respondió: ${(h.stderr || h.stdout).slice(0, 200)}`);
    return `hook: ${h.stdout.trim().split(/\r?\n/)[0].slice(0, 60)}`;
  });

  if (!NO_LOGIN) await step('Claude Code desde la terminal: usa el MCP, registra con «bitacora log» y los hooks corren', async () => {
    const prompt = 'Haz dos cosas y nada más: 1) usa la herramienta get_index del servidor MCP bitacora; 2) corre en la terminal exactamente: bitacora log --item OVW-PROJECT --kind note --summary "Prueba UAT desde Claude Code". Luego responde solo: listo';
    const r = spawnSync('claude', ['-p', prompt, '--model', 'haiku', '--max-turns', '6', '--dangerously-skip-permissions'], {
      // Sin shell: el texto va tal cual (con un shell, las comillas y el «--item» del texto se pierden).
      cwd: PROJECT, env: personEnv({ PATH: `${BIN}${delimiter}${NO_NODE_PATH}` }), encoding: 'utf8', timeout: 240000, input: '',
    });
    const logs = readdirSync(join(PROJECT, 'docs', 'log'), { recursive: true }).map(String).filter((f) => f.endsWith('.md'));
    const note = logs.find((f) => readFileSync(join(PROJECT, 'docs', 'log', f), 'utf8').includes('Prueba UAT desde Claude Code'));
    if (!note) throw new Error(`el agente no registró (salida: ${(r.stdout || r.stderr || '').slice(-300)})`);
    const sessions = existsSync(join(PROJECT, 'docs', '_sessions')) ? readdirSync(join(PROJECT, 'docs', '_sessions'), { recursive: true }).length : 0;
    if (!sessions) throw new Error('los hooks no dejaron registro de la sesión (docs/_sessions)');
    return `registro ${note}; respuesta: ${(r.stdout || '').trim().slice(-40)}`;
  });

  await step('el Puente de la app instalada lo muestra solo (en vivo)', async () => {
    try { await page!.locator('.today', { hasText: 'Prueba UAT desde Claude Code' }).waitFor({ timeout: 15000 }); }
    catch (e) {
      await page!.screenshot({ path: join(OUT, 'fallo-puente.png') }).catch(() => undefined);
      const state = await page!.evaluate(() => `${location.hash} · foco ${document.activeElement?.tagName} · ${document.querySelector('main')?.textContent?.replace(/\s+/g, ' ').slice(0, 160)}`).catch(() => '');
      throw new Error(`${(e as Error).message.split('\n')[0]} · ${state}`);
    }
    await page!.screenshot({ path: join(OUT, '2-puente-en-vivo.png') });
  });

  if (!NO_LOGIN) await step('conversación desde la app instalada (sin Node): responde', async () => {
    await page!.evaluate(() => { location.hash = '#/session/new'; });
    await page!.locator('#composer textarea').waitFor({ timeout: 15000 });
    await page!.locator('#composer textarea').fill('Responde solo con la palabra: listo');
    await page!.locator('#composer button[type="submit"]').click();
    await page!.waitForFunction(() => location.hash.startsWith('#/session/') && !location.hash.endsWith('/new'), undefined, { timeout: 30000 });
    await page!.locator('.msg.assistant .bubble', { hasText: /listo/i }).first().waitFor({ timeout: 120000 });
    await page!.screenshot({ path: join(OUT, '3-conversacion.png') });
  });

  await step('cerrar la app: el proceso termina y no deja Claude Code corriendo', async () => {
    const pid = app!.pid!;
    try { const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); const s = await b.newBrowserCDPSession(); await s.send('Browser.close').catch(() => undefined); } catch { /* ya cerró */ }
    for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); await sleep(250); } catch { break; } }
    try { process.kill(pid, 0); throw new Error('la app sigue abierta 10 s después de cerrarla'); } catch (e) { if ((e as Error).message.startsWith('la app')) throw e; }
    await sleep(1500);
    const left = ps(`(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match [regex]::Escape('${PROJECT.replace(/'/g, "''")}') -or $_.ExecutablePath -eq '${EXE.replace(/'/g, "''")}' }).Count`);
    if (Number(left || 0) > 0) throw new Error(`quedaron ${left} procesos`);
  });
} finally {
  if (app?.pid) { try { process.kill(app.pid); } catch { /* ya cerró */ } }
  await step('desinstalar: no quedan la carpeta ni los accesos directos', async () => {
    const un = existsSync(INSTALL) ? readdirSync(INSTALL).find((f) => /^Uninstall/i.test(f)) : undefined;
    if (!un) throw new Error('no hay desinstalador');
    spawnSync(join(INSTALL, un), ['/S'], { stdio: 'ignore', timeout: 120000 });
    for (let i = 0; i < 40 && existsSync(EXE); i++) await sleep(500);
    if (existsSync(EXE)) throw new Error('quedó el programa');
    const menu = join(process.env.APPDATA!, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${NAME}.lnk`);
    for (let i = 0; i < 40 && existsSync(menu); i++) await sleep(500);
    if (existsSync(menu)) throw new Error('quedó el acceso directo del menú Inicio');
  });
  // Lo que la prueba agregó al PATH del usuario y a Claude Code se quita.
  const now = userPath();
  if (now !== pathBefore) ps(`[Environment]::SetEnvironmentVariable('Path', '${pathBefore.replace(/'/g, "''")}', 'User')`);
  spawnSync('claude', ['mcp', 'remove', 'bitacora', '--scope', 'local'], { cwd: PROJECT, stdio: 'ignore', shell: true });
  writeFileSync(join(OUT, 'uat.json'), JSON.stringify({ setup: SETUP, date: new Date().toISOString(), results }, null, 2));
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad}/${results.length} pasos bien · ${OUT}`);
  process.exit(bad ? 1 : 0);
}
