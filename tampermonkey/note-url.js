// ==UserScript==
// @name         URL Notes Manager (File Storage)
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Per-URL notes with file-based storage via Python server. Dialog is 50% width and 80% height of the viewport (fallback to 90% width on small screens).
// @author       You
// @match        */*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      uicdn.toast.com
// @connect      openrouter.ai
// @connect      localhost
// @require      https://uicdn.toast.com/editor/latest/toastui-editor-all.min.js
// ==/UserScript==

(function () {
  'use strict';

    // Global configuration - Replace with your actual API key
    const OPENROUTER_API_KEY = 'your-openrouter-api-key-here'; // TODO: Replace with actual key

    // Configuration
    const NOTES_API_BASE = 'http://localhost:3001/api/notes'
    const AI_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
    const MODEL_NAME = 'minimax/minimax-m2:free';
    const SYSTEM_PROMPT = `你是一个专业的笔记优化助手。你的任务是改进用户的笔记，使其更加清晰、结构化和易读。

优化规则：
1. 保持原始内容的核心意思和信息
2. 改进语法、拼写和标点符号
3. 优化 Markdown 格式，使用适当的标题、列表和强调
4. 改善段落结构和逻辑流程
5. 保持用户的语气和风格
6. 如果内容是中文，保持中文；如果是英文，保持英文
7. 不要添加原文中没有的信息

请直接输出优化后的笔记内容，不要添加任何解释或评论。`;

  let editorInstance = null;
  let resizeHandler = null;
  let isDockVisible = false;
  let isHoveringDock = false;
  let dockHint = null;

  async function ensureToastCss() {
    if (document.getElementById('toastui-styles-loaded')) return;

    await new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: 'https://uicdn.toast.com/editor/latest/toastui-editor.min.css',
        onload: (r) => { GM_addStyle(r.responseText); resolve(); },
        onerror: () => resolve()
      });
    });

    // Force layout: dialog 50vw x 80vh; editor fills content
    GM_addStyle(`
      /* Fixed font family for all dialogs and components */
      #notes-dialog-overlay,
      #notes-dialog-overlay *,
      #optimized-note-overlay,
      #optimized-note-overlay *,
      #optimize-loading-overlay,
      #optimize-loading-overlay *,
      #toastui-editor-container,
      #toastui-editor-container *,
      .toastui-editor,
      .toastui-editor * {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif !important;
      }

      /* Specific font override for editor content areas */
      #toastui-editor-container .toastui-editor-contents,
      #toastui-editor-container .toastui-editor-md-preview,
      #toastui-editor-container .toastui-editor-md-container textarea,
      #toastui-editor-container .toastui-editor-ww-container,
      #toastui-editor-container .ProseMirror {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif !important;
        font-size: 14px !important;
        line-height: 1.6 !important;
        text-align: left !important;
      }

      /* Force left alignment for the main editor area only */
      #toastui-editor-container .toastui-editor-main {
        text-align: left !important;
      }

      /* Override any monospace fonts in dialogs */
      #notes-dialog-overlay textarea,
      #optimized-note-overlay textarea,
      #optimize-loading-overlay textarea {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif !important;
      }

      /* Dialog sizing and layout */
      #notes-dialog-overlay { height: 100vh !important; }
      .notes-dialog {
        width: 60vw;               /* 60% screen width for better proportions */
        max-width: 900px;          /* slightly smaller max width */
        height: 85vh;              /* 85% of viewport height */
        display: flex;
        flex-direction: column;
        background: white;
        border-radius: 16px;       /* more rounded corners */
        box-shadow: 0 20px 60px rgba(0,0,0,.15);
        overflow: hidden;
      }
      /* Small screens: use 95% width for readability */
      @media (max-width: 900px) {
        .notes-dialog { width: 95vw; height: 90vh; }
      }

      .notes-dialog__header {
        background: white;
        padding: 20px 24px 16px;
        border-bottom: 1px solid #e5e7eb;
        flex-shrink: 0;
      }

      .notes-dialog__title {
        font-size: 18px;
        font-weight: 600;
        color: #1f2937;
        margin: 0 0 12px 0;
      }

      .notes-dialog__url {
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 8px 12px;
        font-size: 13px;
        color: #6b7280;
        word-break: break-all;
      }

      .notes-dialog__content {
        flex: 1;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      /* Editor container must stretch */
      #toastui-editor-container {
        height: 100% !important;
        max-height: 100% !important;
        overflow: hidden;
        flex: 1;
      }

      /* Toast UI internals sizing - cleaner tabs */
      #toastui-editor-container .toastui-editor-defaultUI { height: 100% !important; }
      #toastui-editor-container .toastui-editor-mode-switch {
        background: white !important;
        border-bottom: 1px solid #e5e7eb !important;
        padding: 0 16px !important;
      }
      #toastui-editor-container .toastui-editor-mode-switch .tab-item {
        background: transparent !important;
        border: none !important;
        padding: 12px 16px !important;
        font-size: 14px !important;
        font-weight: 500 !important;
        color: #6b7280 !important;
        border-radius: 6px 6px 0 0 !important;
        margin-right: 4px !important;
      }
      #toastui-editor-container .toastui-editor-mode-switch .tab-item.active {
        background: #f3f4f6 !important;
        color: #1f2937 !important;
      }
      /* toolbar + mode tabs + borders ≈ 96px */
      #toastui-editor-container .toastui-editor-main { height: calc(100% - 96px) !important; }
      #toastui-editor-container .toastui-editor-md-container,
      #toastui-editor-container .toastui-editor-ww-container { height: 100% !important; }
      #toastui-editor-container .toastui-editor-md-preview,
      #toastui-editor-container .toastui-editor-contents { height: 100% !important; }

      .notes-dialog__footer {
        background: white;
        padding: 16px 24px;
        border-top: 1px solid #e5e7eb;
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-shrink: 0;
      }

      /* Motion & ripple */
      @keyframes fadeIn{from{opacity:0}to{opacity:1}}
      @keyframes slideIn{from{opacity:0;transform:translateY(-20px)}to{opacity:1;transform:translateY(0)}}
      @keyframes ripple{from{opacity:1;transform:scale(0)}to{opacity:0;transform:scale(2)}}
      @keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
    `);

    const marker = document.createElement('style');
    marker.id = 'toastui-styles-loaded';
    document.head.appendChild(marker);
  }

  // ======== File Storage API Functions ========

  function createUrlHash() {
    const url = location.href;
    let h = 0;
    for (let i = 0; i < url.length; i++) {
      h = (h << 5) - h + url.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h).toString(36);
  }

  function loadNote() {
    return new Promise((resolve) => {
      const urlHash = createUrlHash();

      GM_xmlhttpRequest({
        method: 'GET',
        url: `${NOTES_API_BASE}/${urlHash}`,
        headers: {
          'Content-Type': 'application/json',
        },
        onload: function(response) {
          try {
            const data = JSON.parse(response.responseText);
            resolve(data.note || '');
          } catch (e) {
            console.error('Error parsing note data:', e);
            resolve('');
          }
        },
        onerror: function(err) {
          console.error('Error loading note:', err);
          resolve('');
        },
        ontimeout: function() {
          console.error('Timeout loading note');
          resolve('');
        }
      });
    });
  }

  function saveNote(note) {
    return new Promise((resolve, reject) => {
      const urlHash = createUrlHash();
      const noteData = {
        note: note,
        url: location.href,
        timestamp: Date.now()
      };

      GM_xmlhttpRequest({
        method: 'POST',
        url: `${NOTES_API_BASE}/${urlHash}`,
        headers: {
          'Content-Type': 'application/json',
        },
        data: JSON.stringify(noteData),
        onload: function(response) {
          try {
            const result = JSON.parse(response.responseText);
            if (result.status === 'saved') {
              resolve(result);
            } else {
              reject(new Error('Save failed: ' + JSON.stringify(result)));
            }
          } catch (e) {
            reject(new Error('Error parsing save response: ' + e.message));
          }
        },
        onerror: function(err) {
          reject(new Error('Error saving note: ' + err.message));
        },
        ontimeout: function() {
          reject(new Error('Timeout saving note'));
        }
      });
    });
  }

  function deleteNote() {
    return new Promise((resolve, reject) => {
      const urlHash = createUrlHash();

      GM_xmlhttpRequest({
        method: 'DELETE',
        url: `${NOTES_API_BASE}/${urlHash}`,
        headers: {
          'Content-Type': 'application/json',
        },
        onload: function(response) {
          try {
            const result = JSON.parse(response.responseText);
            resolve(result);
          } catch (e) {
            reject(new Error('Error parsing delete response: ' + e.message));
          }
        },
        onerror: function(err) {
          reject(new Error('Error deleting note: ' + err.message));
        },
        ontimeout: function() {
          reject(new Error('Timeout deleting note'));
        }
      });
    });
  }

  // ======== LLM Optimization ========
  function optimizeNote(noteContent) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: AI_API_URL,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
        },
        data: JSON.stringify({
          model: MODEL_NAME,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `请优化以下笔记内容：\n\n${noteContent}` },
          ],
          temperature: 0.7,
          max_tokens: 2000,
        }),
        onload: function (response) {
          try {
            const data = JSON.parse(response.responseText);
            if (data.choices && data.choices[0] && data.choices[0].message) {
              resolve(data.choices[0].message.content);
            } else {
              reject(new Error('API 响应格式异常'));
            }
          } catch (e) {
            reject(new Error('解析 API 响应失败: ' + e.message));
          }
        },
        onerror: function (err) {
          reject(new Error('连接 API 失败: ' + err.message));
        },
        ontimeout: function () {
          reject(new Error('API 请求超时'));
        },
      });
    });
  }

  function showOptimizeLoadingDialog() {
    const overlay = document.createElement('div');
    overlay.id = 'optimize-loading-overlay';
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,.5);
      z-index: 1000000; display: flex; align-items: center; justify-content: center;
      animation: fadeIn .3s ease-in-out;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: #fff; border-radius: 12px; padding: 40px; text-align: center;
      box-shadow: 0 10px 40px rgba(0,0,0,.3);
    `;

    const spinner = document.createElement('div');
    spinner.style.cssText = `
      border: 4px solid #f3f3f3; border-top: 4px solid #f59e0b; border-radius: 50%;
      width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto 20px;
    `;

    const text = document.createElement('div');
    text.textContent = '正在优化笔记...';
    text.style.cssText = `color: #666; font-size: 16px;`;

    dialog.appendChild(spinner);
    dialog.appendChild(text);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    return overlay;
  }

  function showOptimizedNoteDialog(originalNote, optimizedNote, applyCallback) {
    const overlay = document.createElement('div');
    overlay.id = 'optimized-note-overlay';
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,.5);
      z-index: 1000000; display: flex; align-items: center; justify-content: center;
      animation: fadeIn .3s ease-in-out;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: white; border-radius: 12px; padding: 0; width: 70vw; height: 85vh;
      box-shadow: 0 10px 40px rgba(0,0,0,.3); display: flex; flex-direction: column;
      animation: slideIn .3s ease-in-out;
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      color: white; padding: 20px 24px; border-radius: 12px 12px 0 0;
      display: flex; justify-content: space-between; align-items: center;
    `;
    const title = document.createElement('h2');
    title.textContent = 'AI 优化结果';
    title.style.cssText = `margin: 0; font-size: 20px; font-weight: 600;`;
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '×';
    closeBtn.title = '关闭';
    closeBtn.style.cssText = `
      background: rgba(255,255,255,.2); border: none; color: white; font-size: 28px;
      width: 32px; height: 32px; border-radius: 50%; cursor: pointer;
      display: flex; align-items: center; justify-content: center; line-height: 1;
      transition: background .2s; padding: 0;
    `;
    closeBtn.addEventListener('mouseover', () => (closeBtn.style.background = 'rgba(255,255,255,.3)'));
    closeBtn.addEventListener('mouseout', () => (closeBtn.style.background = 'rgba(255,255,255,.2)'));
    header.appendChild(title);
    header.appendChild(closeBtn);

    // Content - side by side comparison
    const content = document.createElement('div');
    content.style.cssText = `
      padding: 20px; overflow: hidden; flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 20px;
    `;

    const createPanel = (label, text) => {
      const panel = document.createElement('div');
      panel.style.cssText = `display: flex; flex-direction: column; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;`;

      const panelHeader = document.createElement('div');
      panelHeader.textContent = label;
      panelHeader.style.cssText = `
        background: #f9fafb; padding: 12px 16px; font-weight: 600; color: #374151;
        border-bottom: 1px solid #e5e7eb;
      `;

      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.readOnly = true;
      textarea.style.cssText = `
        flex: 1; padding: 16px; border: none; resize: none; outline: none;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;
        font-size: 14px; line-height: 1.6; background: white;
      `;

      panel.appendChild(panelHeader);
      panel.appendChild(textarea);
      return panel;
    };

    content.appendChild(createPanel('原始笔记', originalNote));
    content.appendChild(createPanel('优化后', optimizedNote));

    // Footer
    const footer = document.createElement('div');
    footer.style.cssText = `
      padding: 16px 24px; border-top: 1px solid #e0e0e0;
      display: flex; justify-content: flex-end; gap: 12px;
    `;

    const mkBtn = (label, isPrimary) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = `
        padding: 10px 20px; border-radius: 6px; cursor: pointer; font-size: 14px;
        font-weight: 500; border: none; transition: all .2s;
        ${isPrimary
          ? 'background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white;'
          : 'background: #f5f5f5; color: #666;'}
      `;
      if (isPrimary) {
        btn.addEventListener('mouseover', () => {
          btn.style.transform = 'translateY(-2px)';
          btn.style.boxShadow = '0 4px 12px rgba(245,158,11,.4)';
        });
        btn.addEventListener('mouseout', () => {
          btn.style.transform = 'translateY(0)';
          btn.style.boxShadow = 'none';
        });
      } else {
        btn.addEventListener('mouseover', () => (btn.style.background = '#e0e0e0'));
        btn.addEventListener('mouseout', () => (btn.style.background = '#f5f5f5'));
      }
      return btn;
    };

    const applyBtn = mkBtn('应用优化', true);
    const copyBtn = mkBtn('复制优化版本', false);
    const cancelBtn = mkBtn('取消', false);

    applyBtn.onclick = () => {
      applyCallback(optimizedNote);
      overlay.remove();
    };

    copyBtn.onclick = () => {
      navigator.clipboard.writeText(optimizedNote).then(() => {
        const original = copyBtn.textContent;
        copyBtn.textContent = '已复制!';
        setTimeout(() => (copyBtn.textContent = original), 1500);
      });
    };

    const cleanupAndClose = () => {
      overlay.remove();
      document.removeEventListener('keydown', escHandler);
    };
    closeBtn.onclick = cleanupAndClose;
    cancelBtn.onclick = cleanupAndClose;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanupAndClose(); });
    const escHandler = (e) => { if (e.key === 'Escape') cleanupAndClose(); };
    document.addEventListener('keydown', escHandler);

    footer.append(copyBtn, cancelBtn, applyBtn);
    dialog.append(header, content, footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  }

  async function showNotes() {
    const existing = document.getElementById('notes-dialog-overlay');
    if (existing) return closeDialog(existing, true);

    await ensureToastCss();

    // Overlay
    const overlay = document.createElement('div');
    overlay.id = 'notes-dialog-overlay';
    overlay.style.cssText = `
      position: fixed; inset: 0;
      background: rgba(0,0,0,.5);
      z-index: 999999;
      display: flex; align-items: center; justify-content: center;
      animation: fadeIn .2s ease-out;
    `;

    // Dialog
    const dialog = document.createElement('div');
    dialog.className = 'notes-dialog';
    dialog.style.cssText = `animation: slideIn .2s ease-out;`;

    // Header
    const header = document.createElement('div');
    header.className = 'notes-dialog__header';
    header.style.position = 'relative';

    const title = document.createElement('h2');
    title.className = 'notes-dialog__title';
    title.textContent = 'URL Notes (File Storage)';

    const urlDisplay = document.createElement('div');
    urlDisplay.className = 'notes-dialog__url';
    urlDisplay.textContent = 'URL  ' + location.href;

    // Add close button to header
    const headerCloseBtn = document.createElement('button');
    headerCloseBtn.innerHTML = '×';
    headerCloseBtn.title = 'Close';
    headerCloseBtn.style.cssText = `
      position: absolute; top: 16px; right: 20px;
      width: 32px; height: 32px; border-radius: 50%; border: none;
      background: #f3f4f6; color: #6b7280; font-size: 18px;
      cursor: pointer; transition: all .2s;
      display: flex; align-items: center; justify-content: center;
    `;
    headerCloseBtn.onmouseenter = () => {
      headerCloseBtn.style.background = '#e5e7eb';
      headerCloseBtn.style.color = '#374151';
    };
    headerCloseBtn.onmouseleave = () => {
      headerCloseBtn.style.background = '#f3f4f6';
      headerCloseBtn.style.color = '#6b7280';
    };
    headerCloseBtn.onclick = () => closeDialog(overlay);

    header.append(title, urlDisplay, headerCloseBtn);

    // Content
    const content = document.createElement('div');
    content.className = 'notes-dialog__content';

    const editorWrap = document.createElement('div');
    editorWrap.id = 'toastui-editor-container';
    content.appendChild(editorWrap);

    // Footer
    const footer = document.createElement('div');
    footer.className = 'notes-dialog__footer';

    const mkBtn = (label, variant = 'secondary', icon = '') => {
      const b = document.createElement('button');
      b.innerHTML = icon ? `${icon} ${label}` : label;

      const styles = {
        primary: `
          background: #3b82f6; color: white;
          border: 1px solid #3b82f6;
        `,
        secondary: `
          background: #f3f4f6; color: #374151;
          border: 1px solid #d1d5db;
        `,
        purple: `
          background: #8b5cf6; color: white;
          border: 1px solid #8b5cf6;
        `
      };

      b.style.cssText = `
        padding: 8px 16px; border-radius: 6px; font-size: 14px;
        font-weight: 500; cursor: pointer; transition: all .2s;
        ${styles[variant] || styles.secondary}
      `;

      // Hover effects
      if (variant === 'primary') {
        b.onmouseenter = () => b.style.background = '#2563eb';
        b.onmouseleave = () => b.style.background = '#3b82f6';
      } else if (variant === 'purple') {
        b.onmouseenter = () => b.style.background = '#7c3aed';
        b.onmouseleave = () => b.style.background = '#8b5cf6';
      } else {
        b.onmouseenter = () => b.style.background = '#e5e7eb';
        b.onmouseleave = () => b.style.background = '#f3f4f6';
      }

      return b;
    };

    // Left side - AI Optimize button
    const leftButtons = document.createElement('div');
    leftButtons.style.cssText = `display: flex; gap: 8px;`;

    const optimizeBtn = mkBtn('AI 优化', 'purple', '✨');
    optimizeBtn.onclick = async () => {
      const currentNote = editorInstance ? editorInstance.getMarkdown() : '';
      if (!currentNote || currentNote.trim().length < 10) {
        alert('笔记内容太少，无法优化');
        return;
      }

      const loadingOverlay = showOptimizeLoadingDialog();
      try {
        const optimizedNote = await optimizeNote(currentNote);
        loadingOverlay.remove();

        showOptimizedNoteDialog(currentNote, optimizedNote, async (optimized) => {
          if (editorInstance) {
            editorInstance.setMarkdown(optimized);
            try {
              await saveNote(optimized);
              const old = saveBtn.textContent;
              saveBtn.textContent = 'Saved!';
              setTimeout(() => (saveBtn.textContent = old), 1500);
            } catch (error) {
              console.error('Save error:', error);
              alert('保存失败: ' + error.message);
            }
          }
        });
      } catch (error) {
        loadingOverlay.remove();
        console.error('优化失败:', error);
        alert('优化失败: ' + error.message);
      }
    };

    leftButtons.appendChild(optimizeBtn);

    // Right side - Save, Clear, Close buttons
    const rightButtons = document.createElement('div');
    rightButtons.style.cssText = `display: flex; gap: 8px;`;

    const saveBtn = mkBtn('Save Note', 'primary');
    const clearBtn = mkBtn('Clear', 'secondary');
    const closeBtn = mkBtn('Close', 'secondary');

    saveBtn.onclick = async () => {
      const md = editorInstance ? editorInstance.getMarkdown() : '';
      try {
        await saveNote(md);
        const old = saveBtn.textContent;
        saveBtn.textContent = 'Saved!';
        setTimeout(() => saveBtn.textContent = old, 1200);
      } catch (error) {
        console.error('Save error:', error);
        alert('保存失败: ' + error.message);
      }
    };

    clearBtn.onclick = async () => {
      if (confirm('Clear this note?')) {
        editorInstance?.setMarkdown('');
        try {
          await saveNote('');
        } catch (error) {
          console.error('Clear error:', error);
        }
      }
    };
    closeBtn.onclick = () => closeDialog(overlay);

    rightButtons.append(saveBtn, clearBtn, closeBtn);
    footer.append(leftButtons, rightButtons);

    // Assemble
    dialog.append(header, content, footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Initialize editor with loaded note
    const heightPx = Math.floor(window.innerHeight * 0.80); // 80vh
    function applyHeight(h) {
      const px = Math.max(520, Math.min(h, 1200));
      editorInstance?.setHeight?.(px);
    }

    // Load note from server
    const initialNote = await loadNote();

    setTimeout(() => {
      try {
        editorInstance = new toastui.Editor({
          el: editorWrap,
          height: `${heightPx}px`,
          minHeight: '520px',
          initialEditType: 'markdown',
          previewStyle: 'tab',
          initialValue: initialNote,
          usageStatistics: false,
          toolbarItems: [],
          hideModeSwitch: true
        });
        applyHeight(heightPx);
      } catch (e) {
        console.error('Toast UI init failed; using textarea fallback', e);
        editorWrap.innerHTML =
          `<textarea style="width:100%; height:100%; padding:12px; border:1px solid #ddd; border-radius:6px; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif; font-size:14px; line-height:1.6;">${initialNote}</textarea>`;
      }
    }, 50);

    // Close behaviors
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDialog(overlay); });
    const onEsc = (e) => { if (e.key === 'Escape') closeDialog(overlay); };
    document.addEventListener('keydown', onEsc, { once: true });

    // Resize handling (keeps 80vh feel)
    resizeHandler = () => applyHeight(Math.floor(window.innerHeight * 0.80));
    window.addEventListener('resize', resizeHandler);

    async function closeDialog(node) {
      try {
        if (editorInstance) {
          try {
            const currentNote = editorInstance.getMarkdown();
            await saveNote(currentNote);
          } catch (error) {
            console.error('Error saving on close:', error);
          }
          editorInstance.destroy();
        }
      } catch {}
      editorInstance = null;
      if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
      node?.remove();
    }
  }

  // Floating dock & button positioned at middle-right with auto-hide
  function dock() {
    let d = document.getElementById('userscript-button-dock');
    if (!d) {
      d = document.createElement('div');
      d.id = 'userscript-button-dock';
      d.style.cssText = `
        position: fixed; right: -30px; top: 50%; transform: translateY(-50%); z-index: 10000;
        display:flex; flex-direction:column; gap:12px; align-items:flex-end; pointer-events:none;
        opacity: 0; transition: right 0.3s ease-in-out, opacity 0.3s ease-in-out;
      `;
      document.body.appendChild(d);
      createDockHint();

      // Auto-hide/show logic
      let hideTimeout;
      function showDock() {
        if (hideTimeout) clearTimeout(hideTimeout);
        d.style.right = '30px';
        d.style.opacity = '1';
        isDockVisible = true;
        updateHintVisibility();
      }

      function hideDock() {
        hideTimeout = setTimeout(() => {
          if (!isHoveringDock) {
            d.style.right = '-30px';
            d.style.opacity = '0';
            isDockVisible = false;
            updateHintVisibility();
          }
        }, 1000); // Delay before hiding dock
      }

      function updateHintVisibility() {
        // Hint should be visible when dock is hidden, hidden when dock is visible
        if (dockHint) {
          dockHint.style.opacity = isDockVisible ? '0' : '0.3';
        }
      }

      function createDockHint() {
        dockHint = document.createElement('div');
        dockHint.style.cssText = `
          position: fixed;
          right: 0;
          top: 50%;
          transform: translateY(-50%);
          width: 3px;
          height: 60px;
          background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
          border-radius: 2px 0 0 2px;
          opacity: 0.3;
          z-index: 9999;
          transition: opacity 0.3s ease-in-out;
          pointer-events: none;
        `;
        document.body.appendChild(dockHint);

        // Show dock on hint hover
        dockHint.addEventListener('mouseenter', () => {
          showDock();
        });
      }

      function checkMouseProximity(e) {
        const mouseX = e.clientX;
        const mouseY = e.clientY;
        const proximityThreshold = 50; // pixels from right edge

        // Check if mouse is near the right edge
        const nearRightEdge = mouseX >= window.innerWidth - proximityThreshold;

        // Only check dock area if dock is visible to prevent jittering
        let inDockArea = false;
        if (isDockVisible) {
          const dockRect = d.getBoundingClientRect();
          inDockArea = mouseX >= dockRect.left && mouseX <= dockRect.right &&
                      mouseY >= dockRect.top && mouseY <= dockRect.bottom;
        }

        if (nearRightEdge || inDockArea) {
          showDock();
        } else {
          hideDock();
        }
      }

      // Mouse move listener
      document.addEventListener('mousemove', checkMouseProximity);

      // Hover tracking for the dock itself
      d.addEventListener('mouseenter', () => {
        isHoveringDock = true;
        showDock();
      });

      d.addEventListener('mouseleave', () => {
        isHoveringDock = false;
        hideDock();
      });
    }
    return d;
  }

  async function addFloatingButton() {
    if (document.getElementById('url-notes-button')) return;
    const d = dock();

    const btn = document.createElement('button');
    btn.id = 'url-notes-button';
    btn.title = 'URL Notes (File Storage) - Ctrl/Cmd + Shift + N';
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z" fill="white"/>
      </svg>
    `;
    btn.style.cssText = `
      pointer-events:auto; width:30px; height:30px; border:none; border-radius:50%;
      background:linear-gradient(135deg,#f59e0b 0%,#d97706 100%); color:#fff;
      display:flex; align-items:center; justify-content:center;
      box-shadow:0 4px 15px rgba(245,158,11,.4); cursor:pointer;
      transition:transform .2s, box-shadow .2s; position:relative;
    `;
    btn.onmouseenter = () => { btn.style.transform = 'scale(1.08)'; btn.style.boxShadow = '0 6px 20px rgba(245,158,11,.6)'; };
    btn.onmouseleave = () => { btn.style.transform = 'scale(1)'; btn.style.boxShadow = '0 4px 15px rgba(245,158,11,.4)'; };
    btn.onmousedown  = () => { btn.style.transform = 'scale(.95)'; };
    btn.onmouseup    = () => { btn.style.transform = 'scale(1.08)'; };
    btn.onclick = () => {
      showNotes();
      const ripple = document.createElement('span');
      ripple.style.cssText = `
        position:absolute; left:50%; top:50%; width:50px; height:50px;
        margin-left:-25px; margin-top:-25px; border-radius:50%;
        background:rgba(255,255,255,.6); animation:ripple .6s; pointer-events:none;
      `;
      btn.appendChild(ripple); setTimeout(() => ripple.remove(), 600);
    };

    // Check if note exists and show indicator
    try {
      const noteContent = await loadNote();
      if (noteContent && noteContent.trim()) {
        // Change the icon to show it has content - add a small corner accent
        const accent = document.createElement('div');
        accent.style.cssText = `
          position:absolute; top:2px; right:2px; width:6px; height:6px;
          background:#10b981; border-radius:50%;
          box-shadow: 0 0 0 1px rgba(255,255,255,0.8);
        `;
        btn.appendChild(accent);

        // Also slightly modify the button's appearance when it has content
        btn.style.boxShadow = '0 4px 15px rgba(245,158,11,.4), 0 0 0 1px rgba(16,185,129,.3)';
      }
    } catch (error) {
      console.error('Error checking note existence:', error);
    }

    d.appendChild(btn);
    updateHintVisibility();
  }

  function boot() { setTimeout(addFloatingButton, 100); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Global shortcut
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'N') {
      e.preventDefault();
      showNotes();
    }
  });
})();