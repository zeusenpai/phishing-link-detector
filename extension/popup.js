document.addEventListener('DOMContentLoaded', async () => {
    // ── DOM references ──────────────────────────────────────────
    const urlBar        = document.getElementById('url-bar');
    const loading       = document.getElementById('loading');
    const result        = document.getElementById('result');
    const statusCard    = document.getElementById('status-card');
    const statusIcon    = document.getElementById('status-icon');
    const statusLabel   = document.getElementById('status-label');
    const riskScore     = document.getElementById('risk-score');
    const meterFill     = document.getElementById('threat-meter-fill');
    const summaryBox    = document.getElementById('summary-box');
    const summaryText   = document.getElementById('summary-text');
    const findingsSection = document.getElementById('findings-section');
    const findingsList  = document.getElementById('findings-list');
    const rescanBtn     = document.getElementById('rescan-btn');
    const scanPulse     = document.getElementById('scan-pulse');

    let currentTab = null;

    // ── Category metadata ───────────────────────────────────────
    const CATEGORY_META = {
        security: { icon: '🔒', label: 'Security',  css: 'cat-security' },
        domain:   { icon: '🌐', label: 'Domain',    css: 'cat-domain'   },
        url:      { icon: '🔗', label: 'URL',       css: 'cat-url'      },
        behavior: { icon: '⚙️', label: 'Behavior',  css: 'cat-behavior' },
    };

    // ── Init ────────────────────────────────────────────────────
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs || !tabs.length || !tabs[0].url) {
            showError("Can't access current tab.");
            return;
        }

        currentTab = tabs[0];
        urlBar.textContent = currentTab.url;

        const internal = /^(chrome|edge|about|chrome-extension|file):\/\//i;
        if (internal.test(currentTab.url)) {
            showResult({ final_probability: 0, prediction: "system" });
            return;
        }

        chrome.storage.local.get([`result_${currentTab.id}`], async (stored) => {
            const cached = stored[`result_${currentTab.id}`];
            if (cached && cached.url === currentTab.url) {
                showResult(cached);
            } else {
                await fetchAndShow(currentTab.url, currentTab.id);
            }
        });

    } catch (err) {
        showError(err.message);
    }

    // ── Re-scan button ──────────────────────────────────────────
    rescanBtn.addEventListener('click', async () => {
        if (!currentTab) return;
        // Reset UI
        result.style.display = 'none';
        loading.style.display = 'flex';
        scanPulse.classList.remove('done');
        await fetchAndShow(currentTab.url, currentTab.id);
    });

    // ── Fetch from backend ──────────────────────────────────────
    async function fetchAndShow(url, tabId) {
        try {
            const res = await fetch(`${API_BASE_URL}/predict`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url })
            });
            if (!res.ok) throw new Error(`Server returned ${res.status}`);
            const data = await res.json();
            data.url = url;
            chrome.storage.local.set({ [`result_${tabId}`]: data });
            showResult(data);
        } catch (e) {
            showError("Backend unreachable. Check your API URL in config.js.");
        }
    }

    // ── Show result ─────────────────────────────────────────────
    function showResult(data) {
        loading.style.display = 'none';
        result.style.display  = 'block';
        scanPulse.classList.add('done');

        const prob = data.final_probability ?? 0;
        const pct  = Math.round(prob * 100);

        // Reset
        findingsList.innerHTML = '';
        summaryBox.style.display     = 'none';
        findingsSection.style.display = 'none';

        // ── System page ──
        if (data.prediction === "system") {
            statusCard.className  = 'threat-card system';
            statusIcon.textContent = '🖥️';
            statusLabel.textContent = 'System Page';
            riskScore.textContent   = 'NOT APPLICABLE';
            animateMeter(5);
            return;
        }

        // ── Threat level classification ──
        if (pct < 40) {
            statusCard.className   = 'threat-card safe';
            statusIcon.textContent = '✅';
            statusLabel.textContent = 'Safe';
        } else if (pct < 70) {
            statusCard.className   = 'threat-card suspicious';
            statusIcon.textContent = '⚠️';
            statusLabel.textContent = 'Suspicious';
        } else {
            statusCard.className   = 'threat-card danger';
            statusIcon.textContent = '🚨';
            statusLabel.textContent = 'Dangerous';
        }

        riskScore.textContent = `RISK  ${pct}%`;
        animateMeter(pct);

        // ── Summary ──
        const reasons = data.reasons;
        if (reasons && typeof reasons === 'object' && reasons.summary) {
            summaryBox.style.display = 'flex';
            summaryText.textContent  = reasons.summary;
        }

        // ── Risk Findings ──
        if (reasons && typeof reasons === 'object') {
            const findings = [];

            for (const cat of ['security', 'domain', 'url', 'behavior']) {
                if (reasons[cat] && Array.isArray(reasons[cat])) {
                    reasons[cat].forEach(text => {
                        if (text && text.trim()) {
                            findings.push({ category: cat, text: text.trim() });
                        }
                    });
                }
            }

            if (findings.length > 0) {
                findingsSection.style.display = 'block';

                findings.forEach((finding, index) => {
                    const meta = CATEGORY_META[finding.category];

                    const row = document.createElement('div');
                    row.className = 'finding-row';
                    row.style.animationDelay = `${index * 0.08}s`;

                    row.innerHTML = `
                        <div class="finding-badge ${meta.css}">${meta.icon}</div>
                        <div class="finding-content">
                            <div class="finding-category ${meta.css}">${meta.label}</div>
                            <div class="finding-text">${escapeHtml(finding.text)}</div>
                        </div>
                    `;

                    findingsList.appendChild(row);
                });
            } else if (pct < 40) {
                // Show a "no risks found" message for safe sites
                findingsSection.style.display = 'block';
                findingsList.innerHTML = `
                    <div class="findings-empty">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <path d="M12 2L3 7V12C3 17.55 6.84 22.74 12 24C17.16 22.74 21 17.55 21 12V7L12 2Z"/>
                            <path d="M9 12L11 14L15 10"/>
                        </svg>
                        No threats detected
                    </div>
                `;
            }
        }
    }

    // ── Threat meter animation ──────────────────────────────────
    function animateMeter(pct) {
        // Force browser reflow before animating
        meterFill.style.width = '0%';
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                meterFill.style.width = `${Math.max(pct, 2)}%`;
            });
        });
    }

    // ── Error ───────────────────────────────────────────────────
    function showError(msg) {
        loading.style.display  = 'none';
        result.style.display   = 'block';
        scanPulse.classList.add('done');

        statusCard.className    = 'threat-card';
        statusIcon.textContent  = '❌';
        statusLabel.textContent = 'Error';
        riskScore.textContent   = '';
        meterFill.style.width   = '0%';

        summaryBox.style.display     = 'none';
        findingsSection.style.display = 'none';

        const errDiv = document.createElement('div');
        errDiv.className = 'error-msg';
        errDiv.textContent = msg;
        result.appendChild(errDiv);
    }

    // ── Utility ─────────────────────────────────────────────────
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
});
