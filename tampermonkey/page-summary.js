// ==UserScript==
// @name         Page Summary Generator with Popup
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Extract webpage text, send to local LLM API for summarization, show in popup dialog with markdown rendering
// @author       You
// @match        */*
// @grant        GM_xmlhttpRequest
// @connect      openrouter.ai
// @require      https://cdn.jsdelivr.net/npm/markdown-it@14.0.0/dist/markdown-it.min.js
// ==/UserScript==

(function() {
    'use strict';

    // Global configuration - Replace with your actual API key
    const OPENROUTER_API_KEY = 'your-openrouter-api-key-here'; // TODO: Replace with actual key

    const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
    const MODEL_NAME = 'minimax/minimax-m2:free';
    // Cache TTL removed - now using permanent cache
    const CACHE_PREFIX = 'page_summary_';
    let isDockVisible = false;
    let isHoveringDock = false;
    let dockHint = null;

    const SYSTEM_PROMPT = `
## 角色
你是"高保真信息压缩助手"。任务是基于给定原文生成简短但完整的总结。

## 硬性规则
1. 不得新增原文未出现的国家、机构、人物、时间、事件或立场。
2. 不得替换或改写原文中的关键术语。
3. 原文中出现的专有名词、数字、日期、机构、人物必须逐一覆盖。
4. 立场和归因保持一致，不得颠倒或混淆。
5. 原文的不确定语气必须保留（如"可能""被视为""分析认为"）。
6. 原文未提及的点，明确写"原文未说明"，禁止自行补充。
7. 所有原文要点都要覆盖，不能遗漏。

## 结构要求
- 总结长度控制在**原文的 1/5–1/4** 左右。
- 使用金字塔逻辑：一句核心结论 → 简要分论据 → 关键证据。
- 语言简洁、书面化，去掉修辞和冗余，适合快速阅读。
- 保留英文专有名词，不做生硬翻译。
- 数据、文件、日期要以"原文提到…""报道指出…"表达。
- 必要时使用数字列表和要点列表 是逻辑更清楚

## 输出格式
- 第1行：标题（8–12字，概括核心）
- 第2行起：正文（连续文字，简洁明了，完整涵盖全部要点）

## 质量自检（执行但不写出）
- 确认所有要点都有覆盖。
- 检查是否有新增/遗漏/替换/改写问题。
- 确认总结足够简短、信息密度高。`;

    // Initialize markdown-it
    let md = null;

    function initMarkdown() {
        if (!md && typeof window.markdownit !== 'undefined') {
            md = window.markdownit({
                html: true,        // Enable HTML tags in source
                linkify: true,     // Autoconvert URL-like text to links
                typographer: true, // Enable smartquotes and other typographic replacements
                breaks: true       // Convert '\n' in paragraphs into <br>
            });
        }
        return md;
    }

    // Markdown to HTML converter using markdown-it
    function markdownToHtml(markdown) {
        const mdInstance = initMarkdown();
        if (mdInstance) {
            return mdInstance.render(markdown);
        }
        // Fallback to simple conversion if markdown-it not loaded
        return markdown.replace(/\n/g, '<br>');
    }

    // Generate a simple hash from a string
    function simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash).toString(36);
    }

    // Get cache key based on URL only
    function getCacheKey() {
        const url = window.location.href;
        return CACHE_PREFIX + simpleHash(url);
    }

    // Get cached summary (no TTL check)
    function getCachedSummary() {
        try {
            const cacheKey = getCacheKey();
            const cached = localStorage.getItem(cacheKey);

            if (!cached) return null;

            const { summary } = JSON.parse(cached);
            return summary;
        } catch (error) {
            console.error('Error reading cache:', error);
            return null;
        }
    }

    // Save summary to cache
    function cacheSummary(summary) {
        try {
            const cacheKey = getCacheKey();
            const cacheData = {
                summary: summary,
                timestamp: Date.now(),
                url: window.location.href
            };
            localStorage.setItem(cacheKey, JSON.stringify(cacheData));

            // Clean up old cache entries (keep only last 50)
            cleanupOldCache();
        } catch (error) {
            console.error('Error saving cache:', error);
        }
    }

    // Clear all page summary cache
    function clearCache() {
        try {
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith(CACHE_PREFIX)) {
                    keys.push(key);
                }
            }

            keys.forEach(key => localStorage.removeItem(key));
            console.log(`Cleared ${keys.length} cache entries`);
            return keys.length;
        } catch (error) {
            console.error('Error clearing cache:', error);
            return 0;
        }
    }

    // Clean up old cache entries
    function cleanupOldCache() {
        try {
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith(CACHE_PREFIX)) {
                    const cached = localStorage.getItem(key);
                    if (cached) {
                        const { timestamp } = JSON.parse(cached);
                        keys.push({ key, timestamp });
                    }
                }
            }

            // Sort by timestamp (oldest first)
            keys.sort((a, b) => a.timestamp - b.timestamp);

            // Remove oldest entries if we have more than 50
            const toRemove = keys.length - 50;
            if (toRemove > 0) {
                for (let i = 0; i < toRemove; i++) {
                    localStorage.removeItem(keys[i].key);
                }
            }
        } catch (error) {
            console.error('Error cleaning cache:', error);
        }
    }

    // Function to extract all visible text from the page
    function extractPageText() {
        const clone = document.body.cloneNode(true);

        // Remove script and style elements
        const scripts = clone.getElementsByTagName('script');
        const styles = clone.getElementsByTagName('style');

        while(scripts.length > 0) {
            scripts[0].parentNode.removeChild(scripts[0]);
        }

        while(styles.length > 0) {
            styles[0].parentNode.removeChild(styles[0]);
        }

        // Get text content and clean it up
        let text = clone.innerText || clone.textContent;

        // Remove excessive whitespace
        text = text.replace(/\n\s*\n\s*\n/g, '\n\n');
        text = text.trim();

        return text;
    }

    // Function to send text to API and get summary
    function generateSummary(text) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: API_URL,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
                },
                data: JSON.stringify({
                    model: MODEL_NAME,
                    messages: [
                        {
                            role: 'system',
                            content: SYSTEM_PROMPT
                        },
                        {
                            role: 'user',
                            content: `用中文总结:\n\n${text}`
                        }
                    ],
                    temperature: 0.7,
                    max_tokens: 1000
                }),
                onload: function(response) {
                    try {
                        const data = JSON.parse(response.responseText);
                        if (data.choices && data.choices[0] && data.choices[0].message) {
                            resolve(data.choices[0].message.content);
                        } else {
                            reject(new Error('Unexpected API response format'));
                        }
                    } catch (error) {
                        reject(new Error('Failed to parse API response: ' + error.message));
                    }
                },
                onerror: function(error) {
                    reject(new Error('Failed to connect to API: ' + error.message));
                },
                ontimeout: function() {
                    reject(new Error('Request to API timed out'));
                }
            });
        });
    }

    // Function to create and show popup dialog
    function showSummaryDialog(summary) {
        // Remove existing dialog if any
        const existingDialog = document.getElementById('summary-dialog-overlay');
        if (existingDialog) {
            existingDialog.remove();
        }

        // Create overlay
        const overlay = document.createElement('div');
        overlay.id = 'summary-dialog-overlay';
        overlay.style.cssText = `
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.5);
            z-index: 999999;
            display: flex;
            align-items: center;
            justify-content: center;
            animation: fadeIn 0.2s ease-out;
        `;

        // Create dialog
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            width: 60vw;
            max-width: 900px;
            height: 85vh;
            display: flex;
            flex-direction: column;
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0,0,0,.15);
            overflow: hidden;
            animation: slideIn 0.2s ease-out;
        `;

        // Small screens: use 95% width for readability
        const mediaQuery = window.matchMedia('(max-width: 900px)');
        if (mediaQuery.matches) {
            dialog.style.width = '95vw';
            dialog.style.height = '90vh';
        }

        // Create header
        const header = document.createElement('div');
        header.style.cssText = `
            background: white;
            padding: 20px 24px 16px;
            border-bottom: 1px solid #e5e7eb;
            flex-shrink: 0;
            position: relative;
        `;

        const title = document.createElement('h2');
        title.textContent = 'Page Summary';
        title.style.cssText = `
            font-size: 18px;
            font-weight: 600;
            color: #1f2937;
            margin: 0 0 12px 0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;
        `;

        const urlDisplay = document.createElement('div');
        urlDisplay.textContent = 'URL: ' + window.location.href;
        urlDisplay.style.cssText = `
            background: #f9fafb;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 8px 12px;
            font-size: 13px;
            color: #6b7280;
            word-break: break-all;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;
        `;

        const closeButton = document.createElement('button');
        closeButton.innerHTML = '×';
        closeButton.title = 'Close';
        closeButton.style.cssText = `
            position: absolute;
            top: 16px;
            right: 20px;
            width: 32px;
            height: 32px;
            border-radius: 50%;
            border: none;
            background: #f3f4f6;
            color: #6b7280;
            font-size: 18px;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;
        `;
        closeButton.addEventListener('mouseover', () => {
            closeButton.style.background = '#e5e7eb';
            closeButton.style.color = '#374151';
        });
        closeButton.addEventListener('mouseout', () => {
            closeButton.style.background = '#f3f4f6';
            closeButton.style.color = '#6b7280';
        });
        closeButton.addEventListener('click', () => {
            overlay.remove();
        });

        header.appendChild(title);
        header.appendChild(urlDisplay);
        header.appendChild(closeButton);

        // Create content area
        const content = document.createElement('div');
        content.style.cssText = `
            flex: 1;
            overflow-y: auto;
            padding: 24px;
            line-height: 1.6;
            color: #333;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;
        `;
        content.innerHTML = markdownToHtml(summary);

        // Create footer with buttons
        const footer = document.createElement('div');
        footer.style.cssText = `
            background: white;
            padding: 16px 24px;
            border-top: 1px solid #e5e7eb;
            display: flex;
            justify-content: flex-end;
            align-items: center;
            flex-shrink: 0;
            gap: 8px;
        `;

        const mkBtn = (label, variant = 'secondary') => {
            const b = document.createElement('button');
            b.textContent = label;

            const styles = {
                primary: `
                    background: #3b82f6; color: white;
                    border: 1px solid #3b82f6;
                `,
                secondary: `
                    background: #f3f4f6; color: #374151;
                    border: 1px solid #d1d5db;
                `,
                danger: `
                    background: #ef4444; color: white;
                    border: 1px solid #ef4444;
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
                b.addEventListener('mouseover', () => b.style.background = '#2563eb');
                b.addEventListener('mouseout', () => b.style.background = '#3b82f6');
            } else if (variant === 'danger') {
                b.addEventListener('mouseover', () => b.style.background = '#dc2626');
                b.addEventListener('mouseout', () => b.style.background = '#ef4444');
            } else {
                b.addEventListener('mouseover', () => b.style.background = '#e5e7eb');
                b.addEventListener('mouseout', () => b.style.background = '#f3f4f6');
            }

            return b;
        };

        const copyButton = mkBtn('Copy to Clipboard', 'primary');
        copyButton.addEventListener('click', () => {
            navigator.clipboard.writeText(summary).then(() => {
                const originalText = copyButton.textContent;
                copyButton.textContent = 'Copied!';
                setTimeout(() => {
                    copyButton.textContent = originalText;
                }, 2000);
            });
        });

        const clearCacheButton = mkBtn('Clear Cache', 'danger');
        clearCacheButton.addEventListener('click', () => {
            if (confirm('Are you sure you want to clear all cached summaries? This action cannot be undone.')) {
                const clearedCount = clearCache();
                alert(`Cleared ${clearedCount} cached summaries.`);
                overlay.remove();
            }
        });

        const closeFooterButton = mkBtn('Close', 'secondary');
        closeFooterButton.addEventListener('click', () => {
            overlay.remove();
        });

        footer.appendChild(copyButton);
        footer.appendChild(clearCacheButton);
        footer.appendChild(closeFooterButton);

        // Assemble dialog
        dialog.appendChild(header);
        dialog.appendChild(content);
        dialog.appendChild(footer);
        overlay.appendChild(dialog);

        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
            }
        });

        // Close on Escape key
        const escapeHandler = (e) => {
            if (e.key === 'Escape') {
                overlay.remove();
                document.removeEventListener('keydown', escapeHandler);
            }
        };
        document.addEventListener('keydown', escapeHandler);

        document.body.appendChild(overlay);
    }

    // Function to show loading dialog
    function showLoadingDialog() {
        const overlay = document.createElement('div');
        overlay.id = 'summary-dialog-overlay';
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
            border-top: 4px solid #10b981;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 0 auto 20px;
        `;

        const text = document.createElement('div');
        text.textContent = 'Generating summary...';
        text.style.cssText = `
            color: #6b7280;
            font-size: 16px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;
        `;

        dialog.appendChild(spinner);
        dialog.appendChild(text);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    }

    // Main function to process the page
    async function processSummary() {
        try {
            showLoadingDialog();

            // Extract page text
            const pageText = extractPageText();

            if (!pageText || pageText.length < 10) {
                const overlay = document.getElementById('summary-dialog-overlay');
                if (overlay) overlay.remove();
                alert('Not enough text content found on the page');
                return;
            }

            // Check cache first
            let summary = getCachedSummary();

            if (!summary) {
                // Generate new summary
                summary = await generateSummary(pageText);

                // Cache the result
                cacheSummary(summary);
            }

            // Remove loading dialog and show summary
            const overlay = document.getElementById('summary-dialog-overlay');
            if (overlay) overlay.remove();

            showSummaryDialog(summary);

        } catch (error) {
            console.error('Error generating summary:', error);
            const overlay = document.getElementById('summary-dialog-overlay');
            if (overlay) overlay.remove();
            alert('Error: ' + error.message);
        }
    }

    // Add CSS animations and styling
    const style = document.createElement('style');
    style.textContent = `
        /* Fixed font family for all dialogs and components */
        #summary-dialog-overlay,
        #summary-dialog-overlay *,
        #optimize-loading-overlay,
        #optimize-loading-overlay * {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif !important;
        }

        /* Motion & animations */
        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }

        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateY(-20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        @keyframes ripple {
            from {
                opacity: 1;
                transform: scale(0);
            }
            to {
                opacity: 0;
                transform: scale(2);
            }
        }

        /* Markdown styling */
        #summary-dialog-overlay h1 {
            font-size: 24px;
            font-weight: 700;
            margin: 16px 0 12px 0;
            color: #1f2937;
            border-bottom: 2px solid #e5e7eb;
            padding-bottom: 8px;
        }

        #summary-dialog-overlay h2 {
            font-size: 20px;
            font-weight: 600;
            margin: 14px 0 10px 0;
            color: #1f2937;
        }

        #summary-dialog-overlay h3 {
            font-size: 18px;
            font-weight: 600;
            margin: 12px 0 8px 0;
            color: #374151;
        }

        #summary-dialog-overlay p {
            margin: 8px 0;
            color: #374151;
        }

        #summary-dialog-overlay ul, #summary-dialog-overlay ol {
            margin: 12px 0;
            padding-left: 24px;
        }

        #summary-dialog-overlay li {
            margin: 6px 0;
            color: #374151;
        }

        #summary-dialog-overlay code {
            background: #f3f4f6;
            padding: 2px 6px;
            border-radius: 4px;
            font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
            font-size: 0.9em;
            color: #dc2626;
        }

        #summary-dialog-overlay pre {
            background: #f3f4f6;
            padding: 12px;
            border-radius: 8px;
            overflow-x: auto;
            margin: 12px 0;
        }

        #summary-dialog-overlay pre code {
            background: none;
            padding: 0;
            color: #374151;
        }

        #summary-dialog-overlay strong {
            font-weight: 600;
            color: #1f2937;
        }

        #summary-dialog-overlay em {
            font-style: italic;
        }

        #summary-dialog-overlay a {
            color: #10b981;
            text-decoration: none;
            border-bottom: 1px solid transparent;
            transition: border-color 0.2s;
        }

        #summary-dialog-overlay a:hover {
            border-bottom-color: #10b981;
        }
    `;
    document.head.appendChild(style);

    // Get or create the shared button dock positioned at middle-right with auto-hide
    function getOrCreateButtonDock() {
        let dock = document.getElementById('userscript-button-dock');

        if (!dock) {
            dock = document.createElement('div');
            dock.id = 'userscript-button-dock';
            dock.style.cssText = `
                position: fixed;
                right: -30px;
                top: 50%;
                transform: translateY(-50%);
                z-index: 10000;
                display: flex;
                flex-direction: column;
                gap: 12px;
                align-items: flex-end;
                pointer-events: none;
                opacity: 0;
                transition: right 0.3s ease-in-out, opacity 0.3s ease-in-out;
            `;
            document.body.appendChild(dock);
            createDockHint();

            // Auto-hide/show logic
            let hideTimeout;
            function showDock() {
                if (hideTimeout) clearTimeout(hideTimeout);
                dock.style.right = '30px';
                dock.style.opacity = '1';
                isDockVisible = true;
                if (dockHint) dockHint.style.opacity = '0';
            }

            function hideDock() {
                hideTimeout = setTimeout(() => {
                    if (!isHoveringDock) {
                        dock.style.right = '-30px';
                        dock.style.opacity = '0';
                        isDockVisible = false;
                        if (dockHint) dockHint.style.opacity = '0.3';
                    }
                }, 1000); // Delay before hiding dock
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
                    background: linear-gradient(135deg, #10b981 0%, #059669 100%);
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
                    const dockRect = dock.getBoundingClientRect();
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
            dock.addEventListener('mouseenter', () => {
                isHoveringDock = true;
                showDock();
            });

            dock.addEventListener('mouseleave', () => {
                isHoveringDock = false;
                hideDock();
            });
        }

        return dock;
    }

    // Add a button to trigger the summary generation
    function addSummaryButton() {
        // Check if button already exists
        if (document.getElementById('page-summary-button')) {
            return;
        }

        const dock = getOrCreateButtonDock();

        const button = document.createElement('button');
        button.id = 'page-summary-button';
        button.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" fill="white" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        `;
        button.title = 'Generate Page Summary';
        button.style.cssText = `
            width: 30px;
            height: 30px;
            padding: 0;
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            color: white;
            border: none;
            border-radius: 50%;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            transform: scale(1);
            pointer-events: auto;
        `;

        // Hover effect
        button.addEventListener('mouseover', function() {
            button.style.transform = 'scale(1.1)';
            button.style.boxShadow = '0 6px 20px rgba(16, 185, 129, 0.6)';
        });

        button.addEventListener('mouseout', function() {
            button.style.transform = 'scale(1)';
            button.style.boxShadow = '0 4px 15px rgba(16, 185, 129, 0.4)';
        });

        // Click animation
        button.addEventListener('mousedown', function() {
            button.style.transform = 'scale(0.95)';
        });

        button.addEventListener('mouseup', function() {
            button.style.transform = 'scale(1.1)';
        });

        // Add ripple effect on click
        button.addEventListener('click', function(e) {
            processSummary();

            // Create ripple element
            const ripple = document.createElement('span');
            ripple.style.cssText = `
                position: absolute;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.6);
                width: 50px;
                height: 50px;
                margin-top: -25px;
                margin-left: -25px;
                top: 50%;
                left: 50%;
                animation: ripple 0.6s;
                pointer-events: none;
            `;

            button.appendChild(ripple);

            setTimeout(() => {
                ripple.remove();
            }, 600);
        });

        dock.appendChild(button);
    }

    // Initialize the script when the page is fully loaded
    function initScript() {
        // Small delay to ensure other scripts have a chance to create the dock
        setTimeout(addSummaryButton, 100);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initScript);
    } else {
        initScript();
    }

    // Optional: Add keyboard shortcut (Ctrl+Shift+S or Cmd+Shift+S)
    document.addEventListener('keydown', function(e) {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') {
            e.preventDefault();
            processSummary();
        }
    });

})();;