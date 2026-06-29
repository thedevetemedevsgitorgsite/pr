
import { createClient } from '@supabase/supabase-js';
import JSZip from 'jszip';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    const url = new URL(request.url);
    const path = url.pathname;
    const postId = url.searchParams.get('id');

    if (path === '/preview' && postId) return handlePreview(postId, env);
    if (path === '/readme' && postId) return handleReadme(postId, env);
    if (path === '/info' && postId) return handleInfo(postId, env);
    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};

// ── handleInfo (unchanged) ──
async function handleInfo(postId, env) { /* same as before */ }

// ── handlePreview (fixed) ──
async function handlePreview(postId, env) {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
    const { data: post, error: postErr } = await supabase
      .from('posts')
      .select('id, name, file_path')
      .eq('id', postId)
      .single();

    if (postErr || !post) return jsonResponse({ error: 'Product not found' }, 404);
    if (!post.file_path) return jsonResponse({ error: 'No file available' }, 404);

    const { data: signedData, error: signErr } = await supabase
      .storage
      .from('uploads')
      .createSignedUrl(post.file_path, 60);

    if (signErr || !signedData?.signedUrl) {
      return jsonResponse({ error: 'Could not access file' }, 500);
    }

    const resp = await fetch(signedData.signedUrl);
    if (!resp.ok) return jsonResponse({ error: 'Download failed' }, 500);
    const buffer = await resp.arrayBuffer();

    const magic = new Uint8Array(buffer.slice(0, 4));
    const isZip = magic[0] === 0x50 && magic[1] === 0x4B;

    if (!isZip) {
      const text = new TextDecoder().decode(buffer);
      if (text.trimStart().startsWith('<')) {
        return new Response(text, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders },
        });
      }
      return jsonResponse({ error: 'Unsupported file format' }, 400);
    }

    const zip = await JSZip.loadAsync(buffer);
    const allFiles = Object.keys(zip.files).filter(f => !zip.files[f].dir);

    const entryFile = findEntryHTML(allFiles);
    if (!entryFile) return jsonResponse({ error: 'No HTML entry found' }, 404);

    const baseDir = entryFile.includes('/') ? entryFile.split('/').slice(0, -1).join('/') + '/' : '';
    const blobMap = {};

    // ── Build blob map using safe base64 conversion ──
    for (const fname of allFiles) {
      const file = zip.files[fname];
      const ext = fname.split('.').pop().toLowerCase();
      const mime = getMime(ext);
      const content = await file.async('arraybuffer');
      const base64 = arrayBufferToBase64(content);
      blobMap[fname] = `data:${mime};base64,${base64}`;
    }

    // Process CSS files
    const cssFiles = allFiles.filter(f => f.endsWith('.css'));
    for (const cssPath of cssFiles) {
      try {
        const cssContent = await zip.files[cssPath].async('string');
        const rewritten = rewriteCSS(cssContent, baseDir, blobMap);
        blobMap[cssPath] = `data:text/css;base64,${btoa(rewritten)}`;
      } catch (_) { /* keep original */ }
    }

    const htmlRaw = await zip.files[entryFile].async('string');
    const rewrittenHtml = rewriteHTML(htmlRaw, baseDir, blobMap, entryFile);

    return new Response(rewrittenHtml, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders },
    });

  } catch (err) {
    console.error('Preview error:', err);
    return jsonResponse({ error: err.message }, 500);
  }
}

// ── handleReadme (unchanged) ──
async function handleReadme(postId, env) { /* same as before */ }

// ── Helper functions ──

// Safe base64 conversion for ArrayBuffer
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function findEntryHTML(files) {
  const priorities = ['index.html', 'main.html', 'home.html', 'index.htm', 'main.htm'];
  for (const name of priorities) {
    if (files.includes(name)) return name;
  }
  for (const name of priorities) {
    const found = files.find(f => f.endsWith('/' + name));
    if (found) return found;
  }
  return files.find(f => f.endsWith('.html') || f.endsWith('.htm')) || null;
}

function getMime(ext) {
  const map = {
    html: 'text/html', htm: 'text/html', css: 'text/css',
    js: 'application/javascript', mjs: 'application/javascript',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
    otf: 'font/otf', ico: 'image/x-icon', json: 'application/json',
    xml: 'application/xml', pdf: 'application/pdf',
  };
  return map[ext] || 'application/octet-stream';
}

function resolvePath(path, baseDir) {
  if (!path) return path;
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:')) return path;
  if (path.startsWith('/')) return path.slice(1);
  let resolved = path;
  if (resolved.startsWith('./')) resolved = resolved.slice(2);
  const parts = (baseDir + resolved).split('/');
  const result = [];
  for (const part of parts) {
    if (part === '..') result.pop();
    else if (part !== '.' && part !== '') result.push(part);
  }
  return result.join('/');
}

// ── Fixed rewriteHTML (single-pass style replacement) ──
function rewriteHTML(html, baseDir, blobMap, entryPath) {
  const entryDir = entryPath.includes('/') ? entryPath.split('/').slice(0, -1).join('/') + '/' : '';
  const basenameMap = {};
  for (const [key, url] of Object.entries(blobMap)) {
    const base = key.split('/').pop();
    if (base) basenameMap[base] = url;
  }

  function getBlobUrl(rawPath) {
    if (!rawPath) return null;
    if (rawPath.startsWith('data:') || rawPath.startsWith('http://') || rawPath.startsWith('https://')) return rawPath;
    const clean = rawPath.split('?')[0].split('#')[0];
    let resolved = resolvePath(clean, entryDir);
    if (blobMap[resolved]) return blobMap[resolved];
    if (resolved.startsWith('/')) {
      const alt = resolved.slice(1);
      if (blobMap[alt]) return blobMap[alt];
    }
    const base = clean.split('/').pop();
    if (base && basenameMap[base]) return basenameMap[base];
    if (blobMap[clean]) return blobMap[clean];
    return null;
  }

  let result = html.replace(/(src|href|srcset)\s*=\s*["']([^"']*)["']/gi, (match, attr, value) => {
    if (attr === 'srcset') {
      const parts = value.split(',').map(p => p.trim());
      const rewritten = parts.map(part => {
        const [urlPart, size] = part.split(/\s+/);
        const blobUrl = getBlobUrl(urlPart);
        if (blobUrl) return size ? `${blobUrl} ${size}` : blobUrl;
        return part;
      }).join(', ');
      return `${attr}="${rewritten}"`;
    }
    const blobUrl = getBlobUrl(value);
    if (blobUrl) return `${attr}="${blobUrl}"`;
    return match;
  });

  // Inline styles
  result = result.replace(/style\s*=\s*["']([^"']*)["']/gi, (match, styleContent) => {
    const rewritten = styleContent.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (m, urlPath) => {
      const blobUrl = getBlobUrl(urlPath);
      if (blobUrl) return `url("${blobUrl}")`;
      return m;
    });
    return `style="${rewritten}"`;
  });

  // ── Single-pass <style> replacement ──
  result = result.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (match, attrs, content) => {
    let rewritten = content.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (m, urlPath) => {
      const blobUrl = getBlobUrl(urlPath);
      if (blobUrl) return `url("${blobUrl}")`;
      return m;
    });
    rewritten = rewritten.replace(/@import\s+["']([^"']+)["']/gi, (m, urlPath) => {
      const blobUrl = getBlobUrl(urlPath);
      if (blobUrl) return `@import "${blobUrl}"`;
      return m;
    });
    return `<style${attrs}>${rewritten}</style>`;
  });

  return result;
}

// ── rewriteCSS (unchanged) ──
function rewriteCSS(css, baseDir, blobMap) {
  const basenameMap = {};
  for (const [key, url] of Object.entries(blobMap)) {
    const base = key.split('/').pop();
    if (base) basenameMap[base] = url;
  }

  function getBlobUrl(rawPath) {
    if (!rawPath) return null;
    if (rawPath.startsWith('data:') || rawPath.startsWith('http://') || rawPath.startsWith('https://')) return rawPath;
    const clean = rawPath.split('?')[0].split('#')[0];
    let resolved = resolvePath(clean, baseDir);
    if (blobMap[resolved]) return blobMap[resolved];
    if (resolved.startsWith('/')) {
      const alt = resolved.slice(1);
      if (blobMap[alt]) return blobMap[alt];
    }
    const base = clean.split('/').pop();
    if (base && basenameMap[base]) return basenameMap[base];
    if (blobMap[clean]) return blobMap[clean];
    return null;
  }

  let result = css.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (m, urlPath) => {
    const blobUrl = getBlobUrl(urlPath);
    if (blobUrl) return `url("${blobUrl}")`;
    return m;
  });
  result = result.replace(/@import\s+["']([^"']+)["']/gi, (m, urlPath) => {
    const blobUrl = getBlobUrl(urlPath);
    if (blobUrl) return `@import "${blobUrl}"`;
    return m;
  });
  return result;
}

// ── JSON helper ──
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
