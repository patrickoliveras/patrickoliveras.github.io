/* Videos para el reproductor — the page.
 * One flow: choose a video, it converts by itself, save it to the player.
 * State lives in `items`; render() draws it. */

import { t, setLang, getLang, initialLang, pct } from './i18n.js';
import { outputName, uniqueName, formatDuration, formatBytes, createEta, TARGET } from './plan.js';
import { createEngine, wasmSupported } from './engine.js';
import { analyze, convert, ConvertError } from './converter.js';
import { createScreen } from './screen.js';
import { makeCard } from './card.js';
import * as save from './save.js';
import { createPreview } from './preview.js';
import { mountDevice } from './device.js';

const $ = (sel, root = document) => root.querySelector(sel);
const storage = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch (_) {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (_) {}
  },
};

// ------------------------------------------------------------ state

/** @type {Array<any>} */
const items = [];
let current = null; // the item the device shows
let analyzing = null;
let converting = null;
let engine = null;
let screen = null;
let preview = null;
let nextId = 1;
const takenNames = new Set();
const engineStatus = { state: 'idle', progress: 0, mode: null };
let wakeLock = null;
let baseTitle = document.title;

const el = {
  root: document.documentElement,
  intro: $('#intro'),
  work: $('#work'),
  input: $('#file-input'),
  lang: $('#lang'),
  device: $('#device'),
  body: $('#device-body'),
  canvas: $('#screen-canvas'),
  play: $('#screen-play'),
  playCaption: $('#play-caption'),
  fit: $('#fit'),
  queue: $('#queue'),
  queueList: $('#queue-list'),
  queueSummary: $('#queue-summary'),
  overlay: $('#drop-overlay'),
  announcer: $('#announcer'),
  privacy: $('#privacy-text'),
  faqHow: $('#faq-how'),
};

// ------------------------------------------------------------ helpers

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function icon(name, cls = 'i') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function announce(text) {
  el.announcer.textContent = '';
  // A tick later so repeated messages are still read.
  setTimeout(() => (el.announcer.textContent = text), 60);
}

function titleOf(name) {
  return String(name).replace(/\.[A-Za-z0-9]{1,5}$/, '').trim() || name;
}

function lang() {
  return getLang();
}

// ------------------------------------------------------------ i18n on static markup

function applyStatic() {
  el.root.lang = lang() === 'es' ? 'es-MX' : 'en';
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((node) => {
    node.setAttribute('aria-label', t(node.dataset.i18nAria));
  });
  el.lang.lang = lang() === 'es' ? 'en' : 'es';
  el.privacy.textContent = t(`hero.privacy.${save.platform}`);
  baseTitle = t('doc.title');
  renderGuideInto(el.faqHow, { outName: lang() === 'es' ? 'tu video.amv' : 'your video.amv', title: lang() === 'es' ? 'tu video' : 'your video' }, false, 3);
}

// ------------------------------------------------------------ items

function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => f && typeof f.name === 'string');
  if (!files.length) return;
  stopPreview();
  for (const file of files) {
    const item = {
      id: nextId++,
      file,
      name: file.name,
      title: titleOf(file.name),
      outName: uniqueName(outputName(file.name), takenNames),
      status: 'checking',
      fit: 'fit',
      progress: null,
      eta: null,
      retrying: false,
      analysis: null,
      thumb: null,
      card: null,
      result: null,
      error: null,
      saved: null,
    };
    items.push(item);
    if (!current || current.status === 'error' || current.status === 'done') current = item;
  }
  announce(t('a11y.announce.added', { title: files.map((f) => titleOf(f.name)).join(', ') }));
  render({ focus: true });
  schedule();
}

function removeItem(item) {
  item.abort?.abort();
  const i = items.indexOf(item);
  if (i >= 0) items.splice(i, 1);
  takenNames.delete(item.outName.toLocaleLowerCase('es'));
  if (current === item) current = items[Math.min(i, items.length - 1)] || null;
  if (preview && preview.item === item) stopPreview();
  render({ focus: true });
  schedule();
}

function schedule() {
  if (!engine) return; // files chosen during start-up wait for the engine
  if (!analyzing) {
    const next = items.find((it) => it.status === 'checking' && !it.analysis);
    if (next) runAnalysis(next);
  }
  if (!converting) {
    const next = items.find((it) => it.status === 'queued');
    if (next) runConversion(next);
  }
}

async function runAnalysis(item) {
  analyzing = item;
  item.abort = new AbortController();
  try {
    const a = await analyze(engine, item.file, { signal: item.abort.signal });
    if (!items.includes(item)) return;
    item.analysis = a;
    if (a.kind === 'already-amv') {
      item.status = 'error';
      item.error = new ConvertError('already-amv');
    } else {
      if (a.thumbnail) {
        try {
          item.thumb = await createImageBitmap(new Blob([a.thumbnail], { type: 'image/png' }));
        } catch (_) {
          item.thumb = null;
        }
      }
      if (a.kind === 'audio-only') {
        const card = await makeCard({ title: item.title, cover: a.cover });
        item.card = card.png;
        item.cardCanvas = card.canvas;
      }
      item.status = 'queued';
    }
  } catch (err) {
    if (!items.includes(item)) return;
    if (err.code === 'cancelled') return;
    item.status = 'error';
    item.error = err instanceof ConvertError ? err : new ConvertError('internal', { message: String(err) });
    announce(t('a11y.announce.error', { title: item.title, error: t(`err.title.${errorKey(item.error)}`) }));
  } finally {
    if (analyzing === item) analyzing = null;
    render();
    schedule();
  }
}

async function runConversion(item) {
  converting = item;
  item.status = 'converting';
  item.progress = 0;
  item.eta = null;
  item.retrying = false;
  item.result = null;
  item.saved = null;
  item.abort = new AbortController();
  const etaOf = createEta();
  const started = performance.now();
  holdWakeLock();
  render();
  try {
    const res = await convert(engine, item.file, item.analysis, {
      stallMs: Number(new URLSearchParams(location.search).get('debug-stall')) || undefined,
      fit: item.fit,
      card: item.card,
      signal: item.abort.signal,
      onAttempt: (a) => {
        item.retrying = a.index > 0;
        item.progress = 0;
        renderProgress(item);
      },
      onProgress: (p) => {
        item.progress = p;
        item.eta = p == null ? null : etaOf((performance.now() - started) / 1000, p);
        renderProgress(item);
      },
    });
    if (!items.includes(item)) return;
    item.result = res;
    item.status = 'done';
    item.progress = 1;
    await prepareDonePicture(item);
    announce(t('a11y.announce.done', { title: item.title }));
    if (document.hidden) chime();
  } catch (err) {
    if (!items.includes(item)) return;
    if (err.code === 'cancelled') {
      if (item.restart) {
        item.restart = false;
        item.status = 'queued';
      }
      return;
    }
    item.status = 'error';
    item.error = err instanceof ConvertError ? err : new ConvertError('internal', { message: String(err) });
    announce(t('a11y.announce.error', { title: item.title, error: t(`err.title.${errorKey(item.error)}`) }));
  } finally {
    if (converting === item) converting = null;
    if (!converting) releaseWakeLock();
    render();
    schedule();
  }
}

/** The done screen shows a real decoded frame from the new file. */
async function prepareDonePicture(item) {
  try {
    const p = createPreview(item.result.blob);
    const d = item.analysis?.duration || item.result.seconds || 0;
    const at = d > 4 ? Math.min(d * 0.2, 30) : 0;
    item.doneFrame = await p.frameAt(at);
    p.dispose();
  } catch (_) {
    item.doneFrame = null;
  }
}

function setFit(item, fit) {
  if (!item || item.fit === fit) return;
  item.fit = fit;
  storage.set('fit', fit);
  stopPreview();
  if (item.status === 'converting') {
    item.restart = true;
    item.abort?.abort();
  } else if (item.status === 'done') {
    item.status = 'queued';
    item.result = null;
    item.saved = null;
  }
  render();
  schedule();
}

function retry(item) {
  item.error = null;
  item.status = item.analysis && item.analysis.kind !== 'already-amv' ? 'queued' : 'checking';
  if (item.status === 'checking') item.analysis = null;
  render({ focus: true });
  schedule();
}

function errorKey(err) {
  if (!err) return 'internal';
  if (err.code === 'not-media') {
    const s = err.detail?.sniffed;
    if (s === 'image' || s === 'document' || s === 'archive') return s;
    if (s === 'text') return 'document';
    return 'not-media';
  }
  const known = ['empty', 'already-amv', 'unreadable', 'incomplete', 'undecodable', 'no-frames', 'out-of-memory', 'engine-unavailable', 'browser-unsupported', 'save-failed'];
  return known.includes(err.code) ? err.code : 'internal';
}

// ------------------------------------------------------------ saving

async function saveToPlayer(item, { allowInternal = false, fromPickStep = false, forcePick = false } = {}) {
  const owner = item || current;
  const targets = item ? [item] : items.filter((it) => it.status === 'done');
  try {
    let root = null;
    if (fromPickStep || forcePick) {
      root = await save.pickFolder();
    } else {
      root = await save.usableRemembered(true);
      if (!root) {
        // First time: say what's about to happen before a system window opens.
        owner.picking = true;
        render({ focus: 'pick' });
        return;
      }
    }
    const target = await save.resolveTarget(root, { allowInternal });
    if (target.warning === 'internal') {
      owner.picking = false;
      showInternalWarning(owner);
      return;
    }
    for (const it of targets) {
      await save.writeTo(target.dir, it.outName, it.result.blob);
      it.saved = { where: 'player', label: target.label };
      it.picking = false;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return; // closed the picker
    if (err && (err.name === 'SecurityError' || err.name === 'NotAllowedError')) {
      owner.picking = true; // the click "expired"; one more click opens the picker
      render({ focus: 'pick' });
      return;
    }
    owner.picking = false;
    owner.saved = { where: 'error', message: String(err && err.message ? err.message : err) };
  }
  render({ focus: 'saved' });
}

function saveToComputer(item) {
  const targets = item ? [item] : items.filter((it) => it.status === 'done');
  targets.forEach((it, i) => {
    setTimeout(() => save.download(it.result.blob, it.outName), i * 700);
    it.saved = { where: 'downloads' };
  });
  render({ focus: 'saved' });
}

let internalWarningFor = null;
function showInternalWarning(item) {
  internalWarningFor = item || current;
  render();
}

// ------------------------------------------------------------ preview playback

function stopPreview() {
  if (preview) {
    preview.dispose();
    preview = null;
  }
  el.play.classList.remove('playing');
  if (el.playCaption) renderPlayCaption();
}

async function togglePreview() {
  const item = current;
  if (!item || item.status !== 'done') return;
  if (preview && preview.item === item) {
    if (preview.playing) {
      preview.pause();
      el.play.classList.remove('playing');
      el.play.setAttribute('aria-label', t('done.playLabel'));
    } else {
      preview.play();
      el.play.classList.add('playing');
      el.play.setAttribute('aria-label', t('done.pause'));
    }
    return;
  }
  stopPreview();
  preview = createPreview(item.result.blob, {
    onFrame: (bmp) => screen.frame(bmp),
    onEnd: () => {
      el.play.classList.remove('playing');
      el.play.setAttribute('aria-label', t('done.playLabel'));
      const p = preview;
      preview = null;
      p?.dispose();
      drawDevice();
      renderPlayCaption();
    },
  });
  preview.item = item;
  el.play.classList.add('playing');
  el.play.setAttribute('aria-label', t('done.pause'));
  try {
    await preview.play();
  } catch (_) {
    stopPreview();
    drawDevice();
  }
}

// ------------------------------------------------------------ rendering

function render({ focus = false } = {}) {
  const state = !items.length ? 'idle' : current?.status === 'done' ? 'done' : 'working';
  el.root.dataset.state = el.root.dataset.state === 'ancient' ? 'ancient' : state;
  el.intro.hidden = !!items.length;
  el.work.hidden = !items.length;
  if (items.length) renderWork(focus);
  else el.work.replaceChildren();
  renderQueue();
  drawDevice();
  renderFit();
  renderPlayCaption();
  updateTitle();
}

function engineLine() {
  if (engineStatus.state === 'offline') return t('engine.offline');
  if (engineStatus.state === 'downloading' || engineStatus.state === 'retrying') {
    return engineStatus.progress > 0 ? t('engine.preparingPct', { pct: pct(engineStatus.progress) }) : t('engine.preparing');
  }
  if (engineStatus.state === 'compiling') return t('engine.preparing');
  return null;
}

function etaText(item) {
  if (item.progress == null) return '';
  if (item.eta == null) return t('item.eta.calculating');
  const s = item.eta;
  if (s < 50) return t('item.eta.lessThanMinute');
  if (s < 90) return t('item.eta.oneMinute');
  if (s < 3600) return t('item.eta.minutes', { n: Math.round(s / 60) });
  return t('item.eta.hours', { h: Math.floor(s / 3600), m: Math.round((s % 3600) / 60) });
}

function metaText(item) {
  const parts = [];
  const d = item.result?.seconds || item.analysis?.duration;
  if (item.status === 'done' && item.result) parts.push(formatBytes(item.result.blob.size, lang()));
  else if (item.file.size) parts.push(formatBytes(item.file.size, lang()));
  if (d) parts.push(formatDuration(d, lang()));
  return parts.join(' · ');
}

function renderWork(focus) {
  const item = current;
  if (!item) return;
  const box = h('div', { class: 'work-inner', 'data-status': item.status });

  const eyebrowText = item.status === 'done' ? item.outName : item.name;
  box.append(h('p', { class: 'eyebrow' }, icon('film', 'i i-sm'), h('span', { text: eyebrowText })));

  if (item.status === 'done') {
    box.append(renderDone(item));
  } else if (item.status === 'error') {
    box.append(renderError(item));
  } else {
    box.append(h('h1', { class: 'work-title display', tabindex: '-1', id: 'work-title', text: item.title }));
    const meta = metaText(item);
    if (meta) box.append(h('p', { class: 'work-meta', text: meta }));
    box.append(renderBusy(item));
  }

  el.work.replaceChildren(box);
  if (focus === true) $('#work-title', el.work)?.focus({ preventScroll: true });
  if (focus === 'saved') ($('.saved', el.work) || $('#work-title', el.work))?.focus?.({ preventScroll: false });
  if (focus === 'pick') $('#pick-title', el.work)?.focus?.({ preventScroll: false });
}

function renderBusy(item) {
  const status = h('div', { class: 'status' });
  const engineMsg = engineLine();
  const waitingForEngine = engineMsg && engineStatus.state !== 'ready';
  let line;
  let sub = '';
  let p = null;
  if (item.status === 'checking') {
    line = waitingForEngine ? engineMsg : t('item.checking');
    sub = waitingForEngine ? t('engine.firstTime') : '';
    p = waitingForEngine ? engineStatus.progress : null;
  } else if (item.status === 'queued') {
    line = t('item.waiting');
    p = 0;
  } else {
    line = item.retrying ? t('item.retrying') : item.progress == null ? t('item.converting') : t('item.convertingPct', { pct: pct(item.progress) });
    sub = etaText(item);
    p = item.progress;
  }
  const lineEl = h('div', { class: 'status-line' }, h('span', { id: 'status-text', text: line }));
  const meter = h(
    'div',
    {
      class: `meter${p == null ? ' indeterminate' : ''}`,
      role: 'progressbar',
      'aria-label': t('a11y.progress'),
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': p == null ? null : String(Math.round(p * 100)),
      id: 'meter',
      style: p == null ? null : { '--p': String(p) },
    },
    h('i')
  );
  status.append(lineEl, meter, h('p', { class: 'status-sub', id: 'status-sub', text: sub }));
  const keepKey = item.analysis?.browserDecode ? 'item.keepVisible' : 'item.keepOpen';
  status.append(h('p', { class: 'note' }, icon('clock', 'i i-sm'), h('span', { text: t(keepKey) })));
  const actions = h('div', { class: 'actions' });
  actions.append(
    h('button', { class: 'btn btn-quiet', type: 'button', 'data-action': 'cancel', onclick: () => removeItem(item) }, t('item.cancel'))
  );
  status.append(actions);
  return status;
}

/** Cheap per-tick update; no DOM rebuild while converting. */
function renderProgress(item) {
  if (item !== current || item.status !== 'converting') {
    renderQueueRow(item);
    updateTitle();
    return;
  }
  const text = $('#status-text', el.work);
  const sub = $('#status-sub', el.work);
  const meter = $('#meter', el.work);
  if (text) {
    text.textContent = item.retrying && !(item.progress > 0)
      ? t('item.retrying')
      : item.progress == null ? t('item.converting') : t('item.convertingPct', { pct: pct(item.progress) });
  }
  if (sub) sub.textContent = etaText(item);
  if (meter) {
    if (item.progress == null) {
      meter.classList.add('indeterminate');
      meter.removeAttribute('aria-valuenow');
    } else {
      meter.classList.remove('indeterminate');
      meter.style.setProperty('--p', String(item.progress));
      meter.setAttribute('aria-valuenow', String(Math.round(item.progress * 100)));
    }
  }
  screen.progress(item.progress || 0);
  renderQueueRow(item);
  updateTitle();
}

function renderDone(item) {
  const frag = document.createDocumentFragment();
  const head = h('div', { class: 'done-head' });
  head.append(h('div', { class: 'done-mark', 'aria-hidden': 'true' }, icon('check', '')));
  head.append(h('h1', { class: 'work-title display', tabindex: '-1', id: 'work-title', text: t('done.title') }));
  frag.append(head);
  frag.append(h('p', { class: 'lede', text: t('done.lede') }));
  frag.append(h('p', { class: 'work-meta', text: `${item.title} · ${metaText(item)}` }));
  frag.append(h('p', { class: 'verified' }, icon('check', 'i i-sm'), h('span', { text: t('done.verified') })));
  // FAT32, which the player's card uses, can't hold a file of 4 GiB or more.
  if (item.result.blob.size >= 4294967295) {
    frag.append(h('div', { class: 'saved warn', role: 'alert' }, icon('alert', 'i'), h('span', { text: t('done.tooBig') })));
  }

  if (internalWarningFor === item) {
    frag.append(
      h('div', { class: 'saved warn', role: 'alert' }, icon('alert', 'i'), h('span', { text: t('player.internalWarning') })),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => { internalWarningFor = null; saveToPlayer(item, { forcePick: true }); } }, t('player.chooseOther')),
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { internalWarningFor = null; saveToPlayer(item, { allowInternal: true }); } }, t('player.useAnyway'))
      )
    );
    return frag;
  }

  if (item.picking) {
    const osKey = save.os === 'mac' ? 'mac' : save.os === 'windows' ? 'windows' : 'other';
    frag.append(
      h(
        'div',
        { class: 'guide pick', role: 'group', 'aria-labelledby': 'pick-title' },
        h('h2', { id: 'pick-title', class: 'guide-title', tabindex: '-1', text: t('player.pickTitle') }),
        h('p', { class: 'pick-help', text: t(`player.pickHelp.${osKey}`) }),
        h('p', { class: 'note' }, icon('lock', 'i i-sm'), h('span', { text: t('player.permission') })),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn btn-primary btn-xl', type: 'button', id: 'pick-btn', 'data-action': 'pick', onclick: () => saveToPlayer(item, { fromPickStep: true }) }, icon('usb'), t('player.pick')),
          h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { item.picking = false; saveToComputer(item); } }, t('done.saveToComputer'))
        )
      )
    );
    return frag;
  }

  const doneCount = items.filter((it) => it.status === 'done').length;
  const actions = h('div', { class: 'actions' });
  if (save.canSaveToFolder()) {
    actions.append(
      h('button', { class: 'btn btn-primary btn-xl', type: 'button', id: 'save-primary', 'data-action': 'save-player', onclick: () => saveToPlayer(item) }, icon('usb'), t('done.saveToPlayer')),
      h('button', { class: 'btn btn-quiet', type: 'button', 'data-action': 'save-download', onclick: () => saveToComputer(item) }, t('done.saveToComputer'))
    );
  } else {
    actions.append(
      h('button', { class: 'btn btn-primary btn-xl', type: 'button', id: 'save-primary', 'data-action': 'save-download', onclick: () => saveToComputer(item) }, icon('save'), t('done.save'))
    );
    if (save.canShare(item.result.blob, item.outName)) {
      actions.append(
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => save.share(item.result.blob, item.outName).catch(() => {}) }, icon('share'), t('done.share'))
      );
    }
  }
  frag.append(actions);
  if (doneCount > 1 && !item.saved) {
    frag.append(
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => (save.canSaveToFolder() ? saveToPlayer(null) : saveToComputer(null)) }, t('done.saveAll', { n: doneCount }))
      )
    );
  }

  if (item.saved) {
    if (item.saved.where === 'error') {
      frag.append(h('div', { class: 'saved warn', role: 'alert', tabindex: '-1' }, icon('alert', 'i'), h('span', {}, h('b', { text: t('err.title.save-failed') }), ' ', t('err.body.save-failed'))));
    } else {
      const msg = item.saved.where === 'player' ? t('saved.player', { where: item.saved.label }) : t('saved.downloads');
      frag.append(h('div', { class: 'saved', tabindex: '-1' }, icon('check', 'i'), h('span', { text: msg })));
      const guide = h('div', { class: 'guide' });
      renderGuideInto(guide, item, item.saved.where === 'player');
      frag.append(guide);
    }
  }

  frag.append(
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn btn-quiet', type: 'button', 'data-action': 'choose' }, icon('plus', 'i i-sm'), t('done.another'))
    )
  );
  return frag;
}

function renderGuideInto(container, item, onPlayer = false, level = 2) {
  container.replaceChildren();
  const isPhone = save.platform !== 'computer';
  container.append(h(`h${level}`, { class: 'guide-title', text: onPlayer ? t('copy.titleDone') : t('copy.title') }));
  const ol = h('ol');
  const osKey = save.os === 'mac' ? 'mac' : save.os === 'windows' ? 'windows' : 'other';
  if (isPhone && !onPlayer) {
    ol.append(h('li', { text: t('copy.phone') }));
  }
  if (!onPlayer) {
    ol.append(h('li', { text: t('copy.connect') }));
    ol.append(h('li', { text: t(`copy.open.${osKey}`) }));
    ol.append(h('li', { text: t('copy.drag', { name: item.outName || item.name }) }));
  }
  ol.append(h('li', { text: t(`copy.eject.${osKey}`) }));
  ol.append(h('li', { text: t('copy.watch', { title: titleOf(item.outName || item.title) }) }));
  container.append(ol);
}

function renderError(item) {
  const frag = document.createDocumentFragment();
  const key = errorKey(item.error);
  const isInfo = key === 'already-amv';
  frag.append(
    h(
      'div',
      { class: 'done-head' },
      h('div', { class: isInfo ? 'done-mark' : 'err-mark', 'aria-hidden': 'true' }, icon(isInfo ? 'check' : 'alert', '')),
      h('h1', { class: 'work-title display', tabindex: '-1', id: 'work-title', text: t(`err.title.${key}`) })
    )
  );
  frag.append(h('p', { class: 'lede', text: t(`err.body.${key}`) }));
  if (isInfo) {
    const guide = h('div', { class: 'guide' });
    renderGuideInto(guide, { outName: item.name, title: item.title });
    frag.append(guide);
  }
  const actions = h('div', { class: 'actions' });
  const canRetry = ['internal', 'out-of-memory', 'engine-unavailable', 'save-failed'].includes(key);
  if (canRetry) {
    actions.append(h('button', { class: 'btn btn-primary', type: 'button', 'data-action': 'retry', onclick: () => retry(item) }, icon('retry'), t('err.retry')));
  }
  actions.append(
    h('button', { class: canRetry ? 'btn btn-secondary' : 'btn btn-primary', type: 'button', 'data-action': 'choose' }, icon('film'), t('err.other'))
  );
  if (items.length > 1) actions.append(h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => removeItem(item) }, t('item.remove')));
  frag.append(actions);

  if (!isInfo) {
    const detailText = diagnostics(item);
    const pre = h('pre', { text: detailText });
    const copyBtn = h('button', { class: 'btn btn-secondary', type: 'button' }, icon('copy', 'i i-sm'), t('err.copy'));
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(detailText);
      } catch (_) {
        const r = document.createRange();
        r.selectNodeContents(pre);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
        document.execCommand?.('copy');
      }
      copyBtn.lastChild.textContent = t('err.copied');
    });
    frag.append(h('details', { class: 'details' }, h('summary', { text: t('err.details') }), pre, copyBtn));
  }
  return frag;
}

function diagnostics(item) {
  const e = item.error || {};
  const a = item.analysis;
  const lines = [
    `archivo: ${item.name} (${item.file.size} bytes, ${item.file.type || 'sin tipo'})`,
    `error: ${e.code || 'desconocido'}${e.detail?.message ? ' — ' + e.detail.message : ''}`,
    `motor: ${engineStatus.mode || '?'} · aislado: ${self.crossOriginIsolated ? 'sí' : 'no'}`,
    `navegador: ${navigator.userAgent}`,
  ];
  if (a?.probe) {
    for (const s of a.probe.streams || []) {
      lines.push(`  stream ${s.index}: ${s.codec_type} ${s.codec_name || '?'}${s.width ? ` ${s.width}x${s.height}` : ''}${s.sample_rate ? ` ${s.sample_rate}Hz ${s.channels}ch` : ''}`);
    }
    if (a.probe.format) lines.push(`  formato: ${a.probe.format.format_name} ${a.probe.format.duration || ''}s`);
  }
  if (e.detail?.problems) lines.push('  ' + JSON.stringify(e.detail.problems).slice(0, 400));
  const log = e.detail?.lines || [];
  if (log.length) lines.push('--- ffmpeg ---', ...log.slice(-30));
  return lines.join('\n');
}

function renderQueue() {
  const show = items.length > 1;
  el.queue.hidden = !show;
  if (!show) {
    el.queueList.replaceChildren();
    return;
  }
  const done = items.filter((it) => it.status === 'done').length;
  el.queueSummary.textContent = t('list.summary', { done, total: items.length });
  el.queueList.replaceChildren(...items.map((it) => h('li', { 'data-id': String(it.id) }, queueRow(it))));
}

function queueRow(it) {
  const thumb = h('canvas', { class: 'q-thumb', width: '128', height: '96', 'aria-hidden': 'true' });
  const src = it.thumb || it.cardCanvas;
  if (src) {
    const c = thumb.getContext('2d');
    c.fillStyle = '#000';
    c.fillRect(0, 0, 128, 96);
    const s = Math.min(128 / src.width, 96 / src.height);
    c.drawImage(src, (128 - src.width * s) / 2, (96 - src.height * s) / 2, src.width * s, src.height * s);
  }
  const state = h('div', { class: 'q-state' });
  let badge = null;
  if (it.status === 'checking') state.textContent = t('item.checking');
  else if (it.status === 'queued') state.textContent = t('item.waiting');
  else if (it.status === 'converting') {
    state.append(
      h('span', { class: 'q-pct', text: it.progress == null ? t('item.converting') : t('item.convertingPct', { pct: pct(it.progress) }) }),
      h('div', { class: 'q-meter', style: { '--p': String(it.progress || 0) } }, h('i'))
    );
  } else if (it.status === 'done') {
    state.textContent = it.saved && it.saved.where !== 'error' ? (it.saved.where === 'player' ? t('saved.player', { where: it.saved.label }) : t('saved.downloads')) : t('done.title');
    badge = h('span', { class: 'q-badge ok', 'aria-hidden': 'true' }, icon('check', ''));
  } else if (it.status === 'error') {
    state.textContent = t(`err.title.${errorKey(it.error)}`);
    badge = h('span', { class: 'q-badge bad', 'aria-hidden': 'true' }, icon('alert', ''));
  }
  return h(
    'button',
    {
      class: 'q-row',
      type: 'button',
      'aria-current': it === current ? 'true' : 'false',
      onclick: () => {
        stopPreview();
        current = it;
        render({ focus: true });
      },
    },
    thumb,
    h('div', { class: 'q-text' }, h('div', { class: 'q-name', text: it.title }), state),
    badge || h('span')
  );
}

function renderQueueRow(it) {
  const li = el.queueList.querySelector(`li[data-id="${it.id}"]`);
  if (!li) return;
  const pctEl = li.querySelector('.q-pct');
  const meter = li.querySelector('.q-meter');
  if (pctEl) pctEl.textContent = it.progress == null ? t('item.converting') : t('item.convertingPct', { pct: pct(it.progress) });
  if (meter) meter.style.setProperty('--p', String(it.progress || 0));
}

function drawDevice() {
  if (!screen) return;
  const item = current;
  el.play.hidden = true;
  if (preview && preview.item === item) {
    el.play.hidden = false;
    return;
  }
  if (!item) return screen.idle();
  if (item.status === 'error') return screen.error();
  if (item.status === 'checking' || !item.analysis) return screen.checking();
  const fit = item.fit;
  const display = item.analysis.display;
  if (item.analysis.kind === 'audio-only' && item.cardCanvas) {
    screen.image(item.cardCanvas);
  } else if (item.status === 'done') {
    if (item.doneFrame) screen.frame(item.doneFrame);
    else screen.still(item.thumb, display, fit);
  } else if (item.status === 'converting') {
    screen.arriving(item.thumb, display, fit, item.progress || 0);
  } else {
    screen.arriving(item.thumb, display, fit, 0);
  }
  if (item.status === 'done') {
    el.play.hidden = false;
    el.play.classList.remove('playing');
    el.play.setAttribute('aria-label', t('done.playLabel'));
  }
}

function renderPlayCaption() {
  const show = current?.status === 'done';
  el.playCaption.hidden = !show;
  if (!show) return;
  const playing = preview && preview.item === current && preview.playing;
  el.playCaption.replaceChildren(icon(playing ? 'pause' : 'play', 'i i-sm'), h('span', { text: playing ? t('done.pause') : t('done.play') }));
}

function renderFit() {
  const item = current;
  const d = item?.analysis?.display;
  const relevant =
    item &&
    item.analysis?.kind === 'video' &&
    d &&
    Math.abs(d.width / d.height / (TARGET.width / TARGET.height) - 1) > 0.05 &&
    ['queued', 'converting', 'done'].includes(item.status);
  el.fit.hidden = !relevant;
  if (!relevant) return;
  el.fit.querySelectorAll('button[data-fit]').forEach((b) => {
    const on = b.dataset.fit === item.fit;
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  });
}

function updateTitle() {
  const active = converting;
  if (document.hidden && current?.status === 'done' && !converting) {
    document.title = t('tab.done', { title: current.title });
  } else if (active && active.progress != null) {
    document.title = t('tab.progress', { pct: pct(active.progress) });
  } else {
    document.title = baseTitle;
  }
}

// ------------------------------------------------------------ niceties

async function holdWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => (wakeLock = null));
    }
  } catch (_) {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  try {
    wakeLock?.release();
  } catch (_) {}
  wakeLock = null;
}

function chime() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    const now = ac.currentTime;
    [659.25, 987.77].forEach((f, i) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, now + i * 0.16);
      g.gain.linearRampToValueAtTime(0.12, now + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.16 + 1.1);
      o.connect(g).connect(ac.destination);
      o.start(now + i * 0.16);
      o.stop(now + i * 0.16 + 1.2);
    });
    setTimeout(() => ac.close(), 1800);
  } catch (_) {}
}

// ------------------------------------------------------------ events

function bindEvents() {
  // Every "choose a video" button opens the same hidden file input.
  document.addEventListener('click', (e) => {
    if (e.target.closest?.('[data-action="choose"]')) el.input.click();
  });

  el.input.addEventListener('change', () => {
    addFiles(el.input.files);
    el.input.value = ''; // choosing the same file again still fires change
  });

  el.lang.addEventListener('click', () => {
    setLang(lang() === 'es' ? 'en' : 'es');
    storage.set('lang', lang());
    applyStatic();
    render();
  });

  el.fit.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-fit]');
    if (b) setFit(current, b.dataset.fit);
  });
  el.fit.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const next = current?.fit === 'fit' ? 'fill' : 'fit';
    setFit(current, next);
    el.fit.querySelector(`button[data-fit="${next}"]`)?.focus();
  });

  el.play.addEventListener('click', () => togglePreview().then(renderPlayCaption));
  el.playCaption.addEventListener('click', () => togglePreview().then(renderPlayCaption));

  // Drag and drop anywhere on the page.
  let depth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    el.overlay.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) el.overlay.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    el.overlay.hidden = true;
    addFiles(e.dataTransfer.files);
  });

  window.addEventListener('paste', (e) => {
    const files = e.clipboardData?.files;
    if (files && files.length) addFiles(files);
  });

  window.addEventListener('beforeunload', (e) => {
    if (converting || analyzing) {
      e.preventDefault();
      e.returnValue = t('leave.warning');
      return t('leave.warning');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (converting) holdWakeLock();
      updateTitle();
    }
  });
}

// ------------------------------------------------------------ boot

/** Serve the page through sw.js so it is cross-origin isolated, which the
 * fast multi-threaded converter needs. On a first visit that means one quick
 * reload, done only if the person hasn't started doing anything yet. */
async function ensureIsolation() {
  if (self.crossOriginIsolated || !('serviceWorker' in navigator)) return;
  const wasControlled = !!navigator.serviceWorker.controller;
  let touched = false;
  const mark = () => (touched = true);
  window.addEventListener('pointerdown', mark, { once: true, capture: true });
  window.addEventListener('keydown', mark, { once: true, capture: true });
  try {
    await navigator.serviceWorker.register('sw.js', { scope: './' });
    if (wasControlled) return; // headers didn't take; carry on single-threaded
    await Promise.race([
      new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })),
      new Promise((r) => setTimeout(r, 3500)),
    ]);
    if (!navigator.serviceWorker.controller || touched || items.length) return;
    let last = 0;
    try {
      last = Number(sessionStorage.getItem('coi-reload') || 0);
      if (Date.now() - last < 20000) return;
      sessionStorage.setItem('coi-reload', String(Date.now()));
    } catch (_) {
      return;
    }
    location.reload();
    await new Promise(() => {}); // the page is going away
  } catch (_) {
    // no service worker (private mode, file://): single-threaded it is
  }
}

async function boot() {
  setLang(initialLang(location.search, storage.get('lang')));
  applyStatic();
  if (!wasmSupported() || typeof Worker === 'undefined' || typeof Blob === 'undefined' || !window.createImageBitmap) {
    el.root.dataset.state = 'ancient';
    $('#ancient').hidden = false;
    el.intro.hidden = true;
    return;
  }
  mountDevice(el.device, el.body);
  screen = createScreen(el.canvas);
  screen.idle();
  bindEvents();
  await ensureIsolation();

  engine = createEngine({
    onLoadProgress: (mode, f) => {
      engineStatus.progress = f;
      engineStatus.mode = mode;
      if (current && current.status === 'checking') render();
    },
    onLoadState: (mode, s) => {
      engineStatus.state = s;
      engineStatus.mode = mode;
      if (current && (current.status === 'checking' || current.status === 'queued')) render();
    },
  });
  engineStatus.mode = engine.preferred;
  // Start fetching the converter right away so it's ready when they choose.
  engine.load(engine.preferred).catch(() => {});
  window.__app = { items, engine, engineStatus }; // for tests and diagnosis
  render();
  schedule();
}

boot();
