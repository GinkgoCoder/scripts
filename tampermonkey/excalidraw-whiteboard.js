// ==UserScript==
// @name         URL Excalidraw Notes (File Storage)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Per-URL drawing notes with Excalidraw and file-based storage via Python server. Dialog is 60% width and 85% height of the viewport.
// @author       You
// @match        */*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @connect      unpkg.com
// @run-at       document-end
// @require      https://unpkg.com/react@18/umd/react.production.min.js
// @require      https://unpkg.com/react-dom@18/umd/react-dom.production.min.js
// @require      https://unpkg.com/@excalidraw/excalidraw@0.17.6/dist/excalidraw.production.min.js
// ==/UserScript==

(function () {
  'use strict';

  // Configuration
  const NOTES_API_BASE = 'http://localhost:3001/api/excalidraw';
  let excalidrawAPI = null;
  let resizeHandler = null;
  let currentElements = [];
  let currentAppState = {};
  let currentFiles = {};
  let isDockVisible = false;
  let isHoveringDock = false;
  let dockHint = null;

  async function ensureExcalidrawStyles() {
    if (document.getElementById('excalidraw-styles-loaded')) return;

    // Add Excalidraw styles and our custom styles
    GM_addStyle(`
      /* Fixed font family for all dialogs and components */
      #excalidraw-dialog-overlay,
      #excalidraw-dialog-overlay *,
      #excalidraw-loading-overlay,
      #excalidraw-loading-overlay * {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif !important;
      }

      /* Dialog sizing and layout */
      #excalidraw-dialog-overlay { height: 100vh !important; }
      .excalidraw-dialog {
        width: 60vw;               /* 60% screen width for better proportions */
        max-width: 1200px;         /* larger max width for drawing */
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
        .excalidraw-dialog { width: 95vw; height: 90vh; }
      }

      .excalidraw-dialog__header {
        background: white;
        padding: 20px 24px 16px;
        border-bottom: 1px solid #e5e7eb;
        flex-shrink: 0;
      }

      .excalidraw-dialog__title {
        font-size: 18px;
        font-weight: 600;
        color: #1f2937;
        margin: 0 0 12px 0;
      }

      .excalidraw-dialog__url {
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 8px 12px;
        font-size: 13px;
        color: #6b7280;
        word-break: break-all;
      }

      .excalidraw-dialog__content {
        flex: 1;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      /* Excalidraw container must stretch */
      #excalidraw-container {
        height: 100% !important;
        max-height: 100% !important;
        overflow: hidden;
        flex: 1;
      }

      .excalidraw-dialog__footer {
        background: white;
        padding: 16px 24px;
        border-top: 1px solid #e5e7eb;
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-shrink: 0;
      }

      /* Motion & animations */
      @keyframes fadeIn{from{opacity:0}to{opacity:1}}
      @keyframes slideIn{from{opacity:0;transform:translateY(-20px)}to{opacity:1;transform:translateY(0)}}
      @keyframes ripple{from{opacity:1;transform:scale(0)}to{opacity:0;transform:scale(2)}}
      @keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
    `);

    const marker = document.createElement('style');
    marker.id = 'excalidraw-styles-loaded';
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

  function loadDrawing() {
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
            resolve(data.drawing || null);
          } catch (e) {
            console.error('Error parsing drawing data:', e);
            resolve(null);
          }
        },
        onerror: function(err) {
          console.error('Error loading drawing:', err);
          resolve(null);
        },
        ontimeout: function() {
          console.error('Timeout loading drawing');
          resolve(null);
        }
      });
    });
  }

  function saveDrawing(drawingData) {
    return new Promise((resolve, reject) => {
      const urlHash = createUrlHash();
      const payload = {
        drawing: drawingData,
        url: location.href,
        timestamp: Date.now()
      };

      GM_xmlhttpRequest({
        method: 'POST',
        url: `${NOTES_API_BASE}/${urlHash}`,
        headers: {
          'Content-Type': 'application/json',
        },
        data: JSON.stringify(payload),
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
          reject(new Error('Error saving drawing: ' + err.message));
        },
        ontimeout: function() {
          reject(new Error('Timeout saving drawing'));
        }
      });
    });
  }

  function deleteDrawing() {
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
            console.log(result);
            resolve(result);
          } catch (e) {
            reject(new Error('Error parsing delete response: ' + e.message));
          }
        },
        onerror: function(err) {
          reject(new Error('Error deleting drawing: ' + err.message));
        },
        ontimeout: function() {
          reject(new Error('Timeout deleting drawing'));
        }
      });
    });
  }

  // Function to show loading dialog
  function showLoadingDialog() {
    const overlay = document.createElement('div');
    overlay.id = 'excalidraw-loading-overlay';
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 999999;
      display: flex;
      align-items: center;
      justify-content: center;
      animation: fadeIn 0.3s ease-in-out;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: white;
      border-radius: 16px;
      padding: 40px;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,.15);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;
    `;

    const spinner = document.createElement('div');
    spinner.style.cssText = `
      border: 4px solid #f3f3f3;
      border-top: 4px solid #6366f1;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      animation: spin 1s linear infinite;
      margin: 0 auto 20px;
    `;

    const text = document.createElement('div');
    text.textContent = 'Loading Excalidraw...';
    text.style.cssText = `
      color: #6b7280;
      font-size: 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;
    `;

    dialog.appendChild(spinner);
    dialog.appendChild(text);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    return overlay;
  }

  async function showExcalidraw() {
    const existing = document.getElementById('excalidraw-dialog-overlay');
    if (existing) return closeDialog(existing);

    await ensureExcalidrawStyles();

    const loadingOverlay = showLoadingDialog();

    // Overlay
    const overlay = document.createElement('div');
    overlay.id = 'excalidraw-dialog-overlay';
    overlay.style.cssText = `
      position: fixed; inset: 0;
      background: rgba(0,0,0,.5);
      z-index: 999999;
      display: flex; align-items: center; justify-content: center;
      animation: fadeIn .2s ease-out;
    `;

    // Dialog
    const dialog = document.createElement('div');
    dialog.className = 'excalidraw-dialog';
    dialog.style.cssText = `animation: slideIn .2s ease-out;`;

    // Header
    const header = document.createElement('div');
    header.className = 'excalidraw-dialog__header';
    header.style.position = 'relative';

    const title = document.createElement('h2');
    title.className = 'excalidraw-dialog__title';
    title.textContent = 'URL Drawing Notes (Excalidraw)';

    const urlDisplay = document.createElement('div');
    urlDisplay.className = 'excalidraw-dialog__url';
    urlDisplay.textContent = 'URL: ' + location.href;

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
    content.className = 'excalidraw-dialog__content';

    const excalidrawContainer = document.createElement('div');
    excalidrawContainer.id = 'excalidraw-container';
    content.appendChild(excalidrawContainer);

    // Footer
    const footer = document.createElement('div');
    footer.className = 'excalidraw-dialog__footer';
    footer.style.cssText = `
      background: white;
      padding: 16px 24px;
      border-top: 1px solid #e5e7eb;
      display: flex;
      justify-content: flex-end;
      align-items: center;
      flex-shrink: 0;
    `;

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
          background: #6366f1; color: white;
          border: 1px solid #6366f1;
        `
      };

      b.style.cssText = `
        padding: 8px 16px; border-radius: 6px; font-size: 14px;
        font-weight: 500; cursor: pointer; transition: all .2s;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;
        ${styles[variant] || styles.secondary}
      `;

      // Hover effects
      if (variant === 'primary') {
        b.onmouseenter = () => b.style.background = '#2563eb';
        b.onmouseleave = () => b.style.background = '#3b82f6';
      } else if (variant === 'purple') {
        b.onmouseenter = () => b.style.background = '#5b21b6';
        b.onmouseleave = () => b.style.background = '#6366f1';
      } else {
        b.onmouseenter = () => b.style.background = '#e5e7eb';
        b.onmouseleave = () => b.style.background = '#f3f4f6';
      }

      return b;
    };


    // Right side - Save, Clear, Close buttons
    const rightButtons = document.createElement('div');
    rightButtons.style.cssText = `display: flex; gap: 8px;`;

    const saveBtn = mkBtn('Save Drawing', 'primary');
    const clearBtn = mkBtn('Clear', 'secondary');
    const closeBtn = mkBtn('Close', 'secondary');

    // Initially disable buttons until Excalidraw is ready
    saveBtn.disabled = true;
    clearBtn.disabled = true;
    saveBtn.style.opacity = '0.6';
    clearBtn.style.opacity = '0.6';

    closeBtn.onclick = () => closeDialog(overlay);

    rightButtons.append(saveBtn, clearBtn, closeBtn);
    footer.append(rightButtons);

    // Assemble
    dialog.append(header, content, footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Load existing drawing
    const existingDrawing = await loadDrawing();

    // Initialize Excalidraw - wait longer for libraries to load
    setTimeout(async () => {
      try {
        loadingOverlay.remove();

        // Access libraries from unsafeWindow to bypass CSP restrictions
        const React = unsafeWindow.React || window.React;
        const ReactDOM = unsafeWindow.ReactDOM || window.ReactDOM;
        const ExcalidrawLib = unsafeWindow.ExcalidrawLib || window.ExcalidrawLib;

        // Wait for libraries to be fully loaded
        if (!React || !ReactDOM || !ExcalidrawLib) {
          throw new Error('Required libraries not loaded');
        }

        // Ensure proper Excalidraw data structure
        const defaultAppState = {
          viewBackgroundColor: "#ffffff",
          currentItemStrokeColor: "#1e1e1e",
          currentItemBackgroundColor: "transparent",
          currentItemFillStyle: "hachure",
          currentItemStrokeWidth: 1,
          currentItemStrokeStyle: "solid",
          currentItemRoughness: 1,
          currentItemOpacity: 100,
          currentItemFontFamily: 1,
          currentItemFontSize: 20,
          currentItemTextAlign: "left",
          currentItemStartArrowhead: null,
          currentItemEndArrowhead: "arrow",
          scrollX: 0,
          scrollY: 0,
          zoom: { value: 1 },
          currentItemRoundness: "round",
          gridSize: null,
          colorPalette: {},
          currentStrokeOptions: null,
          previousGridSize: null,
          frameRendering: { enabled: true, clip: true, name: true, outline: true },
          collaborators: new Map(),
          isBindingEnabled: true,
          isLoading: false,
          errorMessage: null,
          activeEmbeddable: null,
          openMenu: null,
          openPopup: null,
          openSidebar: null,
          lastPointerDownTarget: null,
          selectedElementIds: {},
          selectedGroupIds: {},
          editingGroupId: null,
          editingElement: null,
          activeTool: { type: "selection", locked: false },
          penMode: false,
          penDetected: false,
          exportBackground: true,
          exportEmbedScene: false,
          exportWithDarkMode: false,
          exportScale: 1,
          currentChartType: "bar",
          pasteDialog: { shown: false, data: null },
          contextMenu: null,
          showStats: false,
          currentItemLinearStrokeSharpness: "round",
          viewModeEnabled: false,
          zenModeEnabled: false,
          theme: "light",
          pendingImageElementId: null,
          showHyperlinkPopup: false,
          selectedLinearElement: null,
          multiElement: null,
          originalContainerCache: new WeakMap(),
          elementsMap: new Map(),
          selectedElementsAreBeingDragged: false,
          startBoundElement: null,
          suggestedBindings: [],
          frameToHighlight: null,
          editingFrame: null,
          elementsToHighlight: null,
          toast: null,
          zenModeEnabled: false,
          theme: "light"
        };

        const initialData = existingDrawing ? {
          elements: existingDrawing.elements || [],
          appState: {
            ...defaultAppState,
            ...(existingDrawing.appState || {}),
            // Ensure collaborators is always a Map, not an object
            collaborators: new Map(),
            // Ensure other Map/WeakMap properties are properly initialized
            elementsMap: new Map(),
            originalContainerCache: new WeakMap()
          },
          files: existingDrawing.files || {}
        } : {
          elements: [],
          appState: defaultAppState,
          files: {}
        };

        // Create Excalidraw component using the correct API
        const ExcalidrawComponent = ExcalidrawLib.Excalidraw;

        const excalidrawElement = React.createElement(ExcalidrawComponent, {
          initialData: initialData,
          onChange: (elements, appState, files) => {
            // Update global state
            currentElements = elements;
            currentAppState = appState;
            currentFiles = files;

            // Auto-save on change (debounced)
            clearTimeout(unsafeWindow.excalidrawAutoSaveTimeout);
            unsafeWindow.excalidrawAutoSaveTimeout = setTimeout(async () => {
              try {
                await saveDrawing({ elements, appState, files });
              } catch (error) {
                console.error('Auto-save failed:', error);
              }
            }, 30000);
          },
          ref: (api) => {
            excalidrawAPI = api;
          }
        });

        // Enable buttons after a short delay to ensure Excalidraw is fully mounted
        setTimeout(() => {
          console.log('Enabling buttons after delay');
          saveBtn.disabled = false;
          clearBtn.disabled = false;
          saveBtn.style.opacity = '1';
          clearBtn.style.opacity = '1';

          // Assign event handlers after API is ready
          saveBtn.onclick = async () => {
            console.log('Save button clicked');
            try {
              const sceneData = {
                elements: currentElements,
                appState: currentAppState,
                files: currentFiles
              };
              console.log('Saving drawing:', sceneData);

              await saveDrawing(sceneData);
              const old = saveBtn.textContent;
              saveBtn.textContent = 'Saved!';
              setTimeout(() => saveBtn.textContent = old, 1000);
            } catch (error) {
              console.error('Save error:', error);
              alert('Save failed: ' + error.message);
            }
          };

          clearBtn.onclick = async () => {
            console.log('Clear button clicked');
            if (confirm('Clear this drawing?')) {
              try {
                await deleteDrawing();
                if (excalidrawAPI) {
                  excalidrawAPI.updateScene({ elements: [] });
                }
                // Reset global state
                currentElements = [];
                currentAppState = {};
                currentFiles = {};
              } catch (error) {
                console.error('Delete error:', error);
              }
            }
          };
        }, 1000);

        // Use createRoot for React 18 if available, fallback to render
        if (ReactDOM.createRoot) {
          const root = ReactDOM.createRoot(excalidrawContainer);
          root.render(excalidrawElement);
        } else {
          ReactDOM.render(excalidrawElement, excalidrawContainer);
        }

      } catch (e) {
        loadingOverlay.remove();
        console.error('Excalidraw init failed:', e);
        excalidrawContainer.innerHTML = `
          <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #6b7280; font-size: 16px;">
            <div style="text-align: center;">
              <div style="font-size: 48px; margin-bottom: 16px;">⚠️</div>
              <div>Failed to load Excalidraw</div>
              <div style="font-size: 14px; margin-top: 8px;">Please check your internet connection</div>
            </div>
          </div>
        `;
      }
    }, 500);

    // Close behaviors
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDialog(overlay); });
    const onEsc = (e) => { if (e.key === 'Escape') closeDialog(overlay); };
    document.addEventListener('keydown', onEsc, { once: true });

    // Resize handling
    resizeHandler = () => {
      if (excalidrawAPI) {
        excalidrawAPI.refresh();
      }
    };
    window.addEventListener('resize', resizeHandler);

    async function closeDialog(node) {
      try {
        if (excalidrawAPI) {
          try {
            const sceneData = {
              elements: excalidrawAPI.getSceneElements(),
              appState: excalidrawAPI.getAppState(),
              files: excalidrawAPI.getFiles()
            };
            await saveDrawing(sceneData);
          } catch (error) {
            console.error('Error saving on close:', error);
          }
        }
      } catch {}

      excalidrawAPI = null;
      if (resizeHandler) {
        window.removeEventListener('resize', resizeHandler);
        resizeHandler = null;
      }

      // Clean up React component
      const container = document.getElementById('excalidraw-container');
      if (container) {
        const ReactDOM = unsafeWindow.ReactDOM || window.ReactDOM;
        if (ReactDOM && ReactDOM.createRoot) {
          // React 18 - root cleanup is handled automatically
          container.innerHTML = '';
        } else if (ReactDOM) {
          // React 17 and below
          ReactDOM.unmountComponentAtNode(container);
        }
      }

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
          background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
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
    if (document.getElementById('url-excalidraw-button')) return;
    const d = dock();

    const btn = document.createElement('button');
    btn.id = 'url-excalidraw-button';
    btn.title = 'URL Drawing Notes (Excalidraw) - Ctrl/Cmd + Shift + D';
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="white"/>
      </svg>
    `;
    btn.style.cssText = `
      pointer-events:auto; width:30px; height:30px; border:none; border-radius:50%;
      background:linear-gradient(135deg,#6366f1 0%,#4f46e5 100%); color:#fff;
      display:flex; align-items:center; justify-content:center;
      box-shadow:0 4px 15px rgba(99,102,241,.4); cursor:pointer;
      transition:transform .2s, box-shadow .2s; position:relative;
    `;
    btn.onmouseenter = () => { btn.style.transform = 'scale(1.08)'; btn.style.boxShadow = '0 6px 20px rgba(99,102,241,.6)'; };
    btn.onmouseleave = () => { btn.style.transform = 'scale(1)'; btn.style.boxShadow = '0 4px 15px rgba(99,102,241,.4)'; };
    btn.onmousedown  = () => { btn.style.transform = 'scale(.95)'; };
    btn.onmouseup    = () => { btn.style.transform = 'scale(1.08)'; };
    btn.onclick = () => {
      showExcalidraw();
      const ripple = document.createElement('span');
      ripple.style.cssText = `
        position:absolute; left:50%; top:50%; width:50px; height:50px;
        margin-left:-25px; margin-top:-25px; border-radius:50%;
        background:rgba(255,255,255,.6); animation:ripple .6s; pointer-events:none;
      `;
      btn.appendChild(ripple); setTimeout(() => ripple.remove(), 600);
    };

    // Check if drawing exists and show indicator
    try {
      const drawingData = await loadDrawing();
      if (drawingData && drawingData.elements && drawingData.elements.length > 0) {
        // Change the icon to show it has content - add a small corner accent
        const accent = document.createElement('div');
        accent.style.cssText = `
          position:absolute; top:2px; right:2px; width:6px; height:6px;
          background:#10b981; border-radius:50%;
          box-shadow: 0 0 0 1px rgba(255,255,255,0.8);
        `;
        btn.appendChild(accent);

        // Also slightly modify the button's appearance when it has content
        btn.style.boxShadow = '0 4px 15px rgba(99,102,241,.4), 0 0 0 1px rgba(16,185,129,.3)';
      }
    } catch (error) {
      console.error('Error checking drawing existence:', error);
    }

    d.appendChild(btn);
    updateHintVisibility();
  }

  function boot() { setTimeout(addFloatingButton, 100); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Global shortcut
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      showExcalidraw();
    }
  });
})()
