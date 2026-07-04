/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

// ── Monaco DOM access (injected into TV page) ──
//
// This app's Pine Editor renders Monaco in a subtree with no React fiber
// keys anywhere in its ancestor chain up to <body> (verified empirically —
// walking .parentElement from the editor container never finds a
// __reactFiber$-prefixed key, unlike a typical React app). That means the
// previous approach (find the container, walk up to a fiber, dig
// memoizedProps.value.monacoEnv out of it) can never work here: there is no
// fiber to dig `monacoEnv` out of, and no `window.monaco`/`window.TradingView`
// global exposes the editor instances either.
//
// Instead we drive the editor the same way a person would: the hidden
// `textarea.inputarea` Monaco uses to capture keystrokes is a real,
// DOM-visible element. Typing into it character-by-character works but
// triggers Monaco's auto-indent/auto-close-bracket logic (which mangles
// multi-line source), so writes go through a synthetic `paste` ClipboardEvent
// instead (Monaco inserts pasted text as a literal block, no auto-indent).
// Selecting all text requires a *trusted* key event — dispatching a
// synthetic KeyboardEvent via element.dispatchEvent() does NOT trigger the
// browser's native select-all, so Cmd/Ctrl+A must go through CDP's
// Input.dispatchKeyEvent (same mechanism already used below for Cmd+S).
// This is a Mac build: save/compile is bound to Cmd+S (meta), not Ctrl+S.
const PINE_CONTAINER_SELECTOR = '.monaco-editor.pine-editor-monaco';
const PINE_TEXTAREA_SELECTOR = 'textarea.inputarea';

const IS_EDITOR_OPEN = `(document.querySelector(${JSON.stringify(PINE_CONTAINER_SELECTOR)}) !== null)`;

/**
 * Opens the Pine Editor panel and waits for its Monaco container to appear in the DOM.
 * Returns true if the editor is present, false on timeout.
 */
export async function ensurePineEditorOpen() {
  const already = await evaluate(`(function() { return ${IS_EDITOR_OPEN}; })()`);
  if (already) return true;

  await evaluate(`
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return;
      if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
      else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
    })()
  `);

  await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Pine"]')
        || document.querySelector('[data-name="pine-dialog-button"]');
      if (btn) btn.click();
    })()
  `);

  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    const ready = await evaluate(`(function() { return ${IS_EDITOR_OPEN}; })()`);
    if (ready) return true;
  }
  return false;
}

// Dispatches a trusted key combo via CDP (synthetic DOM KeyboardEvents don't
// trigger native browser behaviors like select-all or save shortcuts).
// modifiers bit field per CDP: Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8.
async function dispatchTrustedKey(key, code, windowsVirtualKeyCode, modifiers) {
  const c = await getClient();
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers, key, code, windowsVirtualKeyCode });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', modifiers, key, code, windowsVirtualKeyCode });
}

async function selectAllInEditor() {
  const found = await evaluate(`
    (function() {
      var ta = document.querySelector(${JSON.stringify(PINE_TEXTAREA_SELECTOR)});
      if (!ta) return false;
      ta.focus();
      return true;
    })()
  `);
  if (!found) throw new Error('Pine Editor input area not found.');
  await dispatchTrustedKey('a', 'KeyA', 65, 4); // Cmd+A (this is a Mac build)
}

// Replaces the full editor buffer via a synthetic paste (Monaco inserts
// pasted text as a literal block — no auto-indent/auto-close mangling like
// character-by-character typing has).
async function pasteIntoEditor(text) {
  await selectAllInEditor();
  const pasted = await evaluate(`
    (function() {
      var ta = document.querySelector(${JSON.stringify(PINE_TEXTAREA_SELECTOR)});
      if (!ta) return false;
      var dt = new DataTransfer();
      dt.setData('text/plain', ${JSON.stringify(text)});
      var evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      ta.dispatchEvent(evt);
      return true;
    })()
  `);
  if (!pasted) throw new Error('Pine Editor input area not found for paste.');
}

// Text patterns for the "add to chart" family of buttons/dialogs, in the
// languages this app has actually been observed running in (English, Polish).
// TradingView's UI language depends on the account/browser locale.
const ADD_TO_CHART_PATTERNS = [
  /^save and add to chart$/i,
  /^zapisz i dodaj do wykresu$/i,
  /^add to chart$/i,
  /^dodaj do wykresu$/i,
  /^update on chart$/i,
  /^zaktualizuj na wykresie$/i,
];
const SAVE_DIALOG_BUTTON_PATTERNS = [/^save$/i, /^zapisz$/i];

async function clickAddToChartOrSave() {
  return evaluate(`
    (function() {
      var patterns = ${JSON.stringify(ADD_TO_CHART_PATTERNS.map(p => p.source))}.map(function(s) { return new RegExp(s, 'i'); });
      var btns = document.querySelectorAll('button');
      for (var p = 0; p < patterns.length; p++) {
        for (var i = 0; i < btns.length; i++) {
          if (btns[i].offsetParent === null) continue;
          if (patterns[p].test(btns[i].textContent.trim())) {
            btns[i].click();
            return btns[i].textContent.trim();
          }
        }
      }
      return null;
    })()
  `);
}

// Clicks the "Save" button inside a "save before switching/adding" dialog,
// as opposed to the toolbar's own save button (same visible text, different
// element — this one is scoped to a dialog/modal container).
async function clickSaveDialogButtonIfPresent() {
  return evaluate(`
    (function() {
      var patterns = ${JSON.stringify(SAVE_DIALOG_BUTTON_PATTERNS.map(p => p.source))}.map(function(s) { return new RegExp(s, 'i'); });
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.offsetParent === null) continue;
        var text = b.textContent.trim();
        var matches = patterns.some(function(p) { return p.test(text); });
        if (!matches) continue;
        var dialog = b.closest('[class*="dialog"], [class*="modal"], [class*="popup"], [role="dialog"]');
        if (dialog) { b.click(); return true; }
      }
      return false;
    })()
  `);
}

// Scrapes Monaco's inline error/warning squiggly decorations and the
// diagnostics banner TradingView renders above the editor on compile. This
// replaces reading getModelMarkers() off the (unreachable) Monaco API —
// it can't recover exact column ranges, only line numbers and messages.
async function scrapeErrorsFromDom() {
  return evaluate(`
    (function() {
      var results = [];
      var seen = {};

      // Diagnostics banner: "N z M problemów" / "N of M problems" + message line(s)
      var bannerMsgs = document.querySelectorAll('[class*="marker"] [class*="message"], [class*="diagnostic"] [class*="message"]');
      bannerMsgs.forEach(function(el) {
        var text = el.textContent.trim();
        if (text && !seen[text]) { seen[text] = true; results.push({ line: null, column: null, message: text, severity: 'error' }); }
      });

      // Inline squiggly decorations (line number recoverable from the view-line ancestor)
      var squiggles = document.querySelectorAll('.squiggly-error, .squiggly-warning');
      squiggles.forEach(function(el) {
        var severity = el.className.indexOf('squiggly-error') !== -1 ? 'error' : 'warning';
        var viewLine = el.closest('[class*="view-line"]');
        var lineNumber = null;
        if (viewLine && viewLine.parentElement) {
          var top = parseInt(viewLine.style.top, 10);
          if (!isNaN(top)) lineNumber = top; // pixel offset, not a line number — best-effort only
        }
        var key = 'squiggle:' + severity + ':' + lineNumber;
        if (!seen[key]) { seen[key] = true; results.push({ line: lineNumber, column: null, message: '(' + severity + ' marker, no message text recoverable from DOM)', severity: severity }); }
      });

      return results;
    })()
  `);
}

// ── Pure / offline functions ──

export function analyze({ source }) {
  const lines = source.split('\n');
  const diagnostics = [];

  let isV6 = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//@version=6')) { isV6 = true; break; }
    if (trimmed.startsWith('//@version=')) break;
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    break;
  }

  const arrays = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fromMatch = line.match(/(\w+)\s*=\s*array\.from\(([^)]*)\)/);
    if (fromMatch) {
      const name = fromMatch[1].trim();
      const args = fromMatch[2].trim();
      const size = args === '' ? 0 : args.split(',').length;
      arrays.set(name, { name, size, line: i + 1 });
      continue;
    }
    const newMatch = line.match(/(\w+)\s*=\s*array\.new(?:<\w+>|_\w+)\((\d+)?/);
    if (newMatch) {
      const name = newMatch[1].trim();
      const size = newMatch[2] !== undefined ? parseInt(newMatch[2], 10) : null;
      arrays.set(name, { name, size, line: i + 1 });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pattern = /array\.(get|set)\(\s*(\w+)\s*,\s*(-?\d+)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const method = match[1];
      const arrName = match[2];
      const idx = parseInt(match[3], 10);
      const info = arrays.get(arrName);
      if (!info || info.size === null) continue;
      if (idx < 0 || idx >= info.size) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `array.${method}(${arrName}, ${idx}) — index ${idx} out of bounds (array size is ${info.size})`,
          severity: 'error',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstLastPattern = /(\w+)\.(first|last)\(\)/g;
    let match;
    while ((match = firstLastPattern.exec(line)) !== null) {
      const arrName = match[1];
      if (arrName === 'array') continue;
      const info = arrays.get(arrName);
      if (info && info.size === 0) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `${arrName}.${match[2]}() called on possibly empty array (declared with size 0)`,
          severity: 'warning',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.includes('strategy.entry') || trimmed.includes('strategy.close')) {
      let hasStrategyDecl = false;
      for (const l of lines) {
        if (l.trim().startsWith('strategy(')) { hasStrategyDecl = true; break; }
      }
      if (!hasStrategyDecl) {
        diagnostics.push({
          line: i + 1, column: 1,
          message: 'strategy.entry/close used but no strategy() declaration found — did you mean to use indicator()?',
          severity: 'error',
        });
        break;
      }
    }
  }

  if (!isV6 && source.includes('//@version=')) {
    const vMatch = source.match(/\/\/@version=(\d+)/);
    if (vMatch && parseInt(vMatch[1]) < 5) {
      diagnostics.push({
        line: 1, column: 1,
        message: `Script uses Pine v${vMatch[1]} — consider upgrading to v6 for latest features`,
        severity: 'info',
      });
    }
  }

  return {
    success: true,
    issue_count: diagnostics.length,
    diagnostics,
    note: diagnostics.length === 0 ? 'No static analysis issues found. Use pine_compile or pine_smart_compile for full server-side compilation check.' : undefined,
  };
}

export async function check({ source }) {
  const formData = new URLSearchParams();
  formData.append('source', source);

  const response = await fetch(
    'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.tradingview.com/',
      },
      body: formData,
    }
  );

  if (!response.ok) {
    throw new Error(`TradingView API returned ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  const errors = [];
  const warnings = [];
  const inner = result?.result;

  if (inner) {
    if (inner.errors2 && inner.errors2.length > 0) {
      for (const e of inner.errors2) {
        errors.push({
          line: e.start?.line, column: e.start?.column,
          end_line: e.end?.line, end_column: e.end?.column,
          message: e.message,
        });
      }
    }
    if (inner.warnings2 && inner.warnings2.length > 0) {
      for (const w of inner.warnings2) {
        warnings.push({ line: w.start?.line, column: w.start?.column, message: w.message });
      }
    }
  }

  if (result.error && typeof result.error === 'string') {
    errors.push({ message: result.error });
  }

  const compiled = errors.length === 0;
  return {
    success: true,
    compiled,
    error_count: errors.length,
    warning_count: warnings.length,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    note: compiled ? 'Pine Script compiled successfully.' : undefined,
  };
}

// ── Functions requiring TradingView connection ──

export async function getSource() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  await selectAllInEditor();
  const source = await evaluate(`
    (function() {
      var ta = document.querySelector(${JSON.stringify(PINE_TEXTAREA_SELECTOR)});
      return ta ? ta.value : null;
    })()
  `);

  if (source === null || source === undefined) {
    throw new Error('Pine Editor input area not found.');
  }

  // Monaco's hidden accessibility textarea truncates the middle of long
  // selections with an ellipsis rather than mirroring the full buffer —
  // there is no reliable way to recover the true full text for large
  // scripts without access to the Monaco model API (unreachable in this
  // build, see the note at the top of this file).
  const truncated = source.includes('…');
  return {
    success: true,
    source,
    line_count: source.split('\n').length,
    char_count: source.length,
    truncated,
    note: truncated
      ? 'Source was truncated by the editor — this only reflects the start/end of the script, not the full body. There is no reliable way to read back a full large script in this TradingView build.'
      : undefined,
  };
}

export async function setSource({ source }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  await pasteIntoEditor(source);
  return { success: true, lines_set: source.split('\n').length };
}

export async function compile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  await dispatchTrustedKey('s', 'KeyS', 83, 4); // Cmd+S (this is a Mac build)
  await new Promise(r => setTimeout(r, 800));

  // New/unsaved scripts prompt for a name before they can be added to chart.
  const dialogHandled = await clickSaveDialogButtonIfPresent();
  if (dialogHandled) await new Promise(r => setTimeout(r, 800));

  const clicked = await clickAddToChartOrSave();
  await new Promise(r => setTimeout(r, 1500));

  return { success: true, button_clicked: clicked || 'Cmd+S', source: 'dom_fallback' };
}

export async function getErrors() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const errors = await scrapeErrorsFromDom();
  return {
    success: true,
    has_errors: errors?.length > 0,
    error_count: errors?.length || 0,
    errors: errors || [],
  };
}

export async function save() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  await dispatchTrustedKey('s', 'KeyS', 83, 4); // Cmd+S (this is a Mac build)
  await new Promise(r => setTimeout(r, 800));

  const dialogHandled = await clickSaveDialogButtonIfPresent();
  if (dialogHandled) await new Promise(r => setTimeout(r, 500));

  return { success: true, action: dialogHandled ? 'saved_with_dialog' : 'Cmd+S_dispatched' };
}

export async function getConsole() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const entries = await evaluate(`
    (function() {
      var results = [];
      var rows = document.querySelectorAll('[class*="consoleRow"], [class*="log-"], [class*="consoleLine"]');
      if (rows.length === 0) {
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]')
          || document.querySelector('[class*="bottom-widgetbar-content"]');
        if (bottomArea) {
          rows = bottomArea.querySelectorAll('[class*="message"], [class*="log"], [class*="console"]');
        }
      }
      if (rows.length === 0) {
        var pinePanel = document.querySelector('.pine-editor-container')
          || document.querySelector('[class*="pine-editor"]')
          || document.querySelector('[class*="layout__area--bottom"]');
        if (pinePanel) {
          var allSpans = pinePanel.querySelectorAll('span, div');
          for (var s = 0; s < allSpans.length; s++) {
            var txt = allSpans[s].textContent.trim();
            if (/^\\d{2}:\\d{2}:\\d{2}/.test(txt) || /error|warning|info/i.test(allSpans[s].className)) {
              rows = Array.from(rows || []);
              rows.push(allSpans[s]);
            }
          }
        }
      }
      for (var i = 0; i < rows.length; i++) {
        var text = rows[i].textContent.trim();
        if (!text) continue;
        var ts = null;
        var tsMatch = text.match(/^(\\d{4}-\\d{2}-\\d{2}\\s+)?\\d{2}:\\d{2}:\\d{2}/);
        if (tsMatch) ts = tsMatch[0];
        var type = 'info';
        var cls = rows[i].className || '';
        if (/error/i.test(cls) || /error/i.test(text.substring(0, 30))) type = 'error';
        else if (/compil/i.test(text.substring(0, 40))) type = 'compile';
        else if (/warn/i.test(cls)) type = 'warning';
        results.push({ timestamp: ts, type: type, message: text });
      }
      return results;
    })()
  `);

  return { success: true, entries: entries || [], entry_count: entries?.length || 0 };
}

export async function smartCompile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const studiesBefore = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  await dispatchTrustedKey('s', 'KeyS', 83, 4); // Cmd+S (this is a Mac build)
  await new Promise(r => setTimeout(r, 800));

  const dialogHandled = await clickSaveDialogButtonIfPresent();
  if (dialogHandled) await new Promise(r => setTimeout(r, 800));

  const buttonClicked = await clickAddToChartOrSave();
  await new Promise(r => setTimeout(r, 2500));

  const errors = await scrapeErrorsFromDom();

  const studiesAfter = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const studyAdded = (studiesBefore !== null && studiesAfter !== null) ? studiesAfter > studiesBefore : null;

  return {
    success: true,
    button_clicked: buttonClicked || 'Cmd+S',
    has_errors: errors?.length > 0,
    errors: errors || [],
    study_added: studyAdded,
  };
}

export async function newScript({ type }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const typeMap = { indicator: 'indicator', strategy: 'strategy', library: 'library' };
  const templates = {
    indicator: '//@version=6\nindicator("My script")\nplot(close)',
    strategy: '//@version=6\nstrategy("My strategy", overlay=true)\n',
    library: '//@version=6\n// @description TODO: add library description here\nlibrary("MyLibrary")\n',
  };

  const template = templates[type] || templates.indicator;

  // NOTE: this replaces the CURRENT editor buffer with a blank template —
  // it does not create a distinct new tab. If another script (including a
  // read-only/protected one) happens to be open, its buffer gets this
  // template pasted into it instead. That buffer is never saved back over
  // a protected script (TradingView blocks saving read-only scripts), but
  // callers that need a guaranteed-fresh tab should drive the "Stwórz nowy"
  // menu in the script-title dropdown manually rather than rely on this.
  await pasteIntoEditor(template);

  return { success: true, type, action: 'new_script_created', template: typeMap[type] };
}

export async function openScript({ name }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const escapedName = JSON.stringify(name.toLowerCase());

  const result = await evaluateAsync(`
    (function() {
      var target = ${escapedName};
      return fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(scripts) {
          if (!Array.isArray(scripts)) return {error: 'pine-facade returned unexpected data'};
          var match = null;
          for (var i = 0; i < scripts.length; i++) {
            var sn = (scripts[i].scriptName || '').toLowerCase();
            var st = (scripts[i].scriptTitle || '').toLowerCase();
            if (sn === target || st === target) { match = scripts[i]; break; }
          }
          if (!match) {
            for (var j = 0; j < scripts.length; j++) {
              var sn2 = (scripts[j].scriptName || '').toLowerCase();
              var st2 = (scripts[j].scriptTitle || '').toLowerCase();
              if (sn2.indexOf(target) !== -1 || st2.indexOf(target) !== -1) { match = scripts[j]; break; }
            }
          }
          if (!match) return {error: 'Script "' + target + '" not found. Use pine_list_scripts to see available scripts.'};

          var id = match.scriptIdPart;
          var ver = match.version || 1;
          return fetch('https://pine-facade.tradingview.com/pine-facade/get/' + id + '/' + ver, { credentials: 'include' })
            .then(function(r2) { return r2.json(); })
            .then(function(data) {
              var source = data.source || '';
              if (!source) return {error: 'Script source is empty', name: match.scriptName || match.scriptTitle};
              return {success: true, name: match.scriptName || match.scriptTitle, id: id, lines: source.split('\\n').length, source: source};
            });
        })
        .catch(function(e) { return {error: e.message}; });
    })()
  `);

  if (result?.error) {
    throw new Error(result.error);
  }

  await pasteIntoEditor(result.source);

  return { success: true, name: result.name, script_id: result.id, lines: result.lines, source: 'internal_api', opened: true };
}

export async function listScripts() {
  const scripts = await evaluateAsync(`
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!Array.isArray(data)) return {scripts: [], error: 'Unexpected response from pine-facade'};
        return {
          scripts: data.map(function(s) {
            return {
              id: s.scriptIdPart || null,
              name: s.scriptName || s.scriptTitle || 'Untitled',
              title: s.scriptTitle || null,
              version: s.version || null,
              modified: s.modified || null,
            };
          })
        };
      })
      .catch(function(e) { return {scripts: [], error: e.message}; })
  `);

  return {
    success: true,
    scripts: scripts?.scripts || [],
    count: scripts?.scripts?.length || 0,
    source: 'internal_api',
    error: scripts?.error,
  };
}
