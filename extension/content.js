// Detect password inputs
let passwordAlertShown = false;
document.addEventListener('input', (e) => {
    if (e.target.type === 'password' && !passwordAlertShown) {
        chrome.runtime.sendMessage({ type: "PASSWORD_DETECTED" });
        passwordAlertShown = true;
    }
}, { capture: true });

// Listen for messages from background.js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "SHOW_WARNING") {
        showBanner(request.data);
        sendResponse({ status: "ok" });
    } else if (request.action === "PASSWORD_ALERT") {
        alert("⚠️ You are entering a password on a suspicious website!");
    }
});

function showBanner(data) {
    const existing = document.getElementById('shield-banner');
    if (existing) existing.remove();

    const prob = data.final_probability ?? 0;
    const pct = Math.round(prob * 100);

    // Only show banner for suspicious or dangerous
    if (prob < 0.40) return;

    const isDangerous = prob >= 0.70;
    const bg = isDangerous ? '#ef4444' : '#f59e0b';
    const icon = isDangerous ? '🚨' : '⚠️';
    const label = isDangerous
        ? `Phishing risk detected (${pct}%)`
        : `Suspicious site (${pct}% risk)`;

    // Get concise reason
    let reason = '';
    if (data.reasons) {
        if (data.reasons.summary) {
            reason = data.reasons.summary;
        } else {
            for (const key of ['domain', 'security', 'url', 'behavior']) {
                if (data.reasons[key] && data.reasons[key].length > 0) {
                    reason = ' — ' + data.reasons[key][0];
                    break;
                }
            }
        }
    }

    const banner = document.createElement('div');
    banner.id = 'shield-banner';
    Object.assign(banner.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: '100%',
        background: bg,
        color: '#fff',
        padding: '10px 16px',
        fontSize: '14px',
        fontWeight: '600',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
        zIndex: '2147483647',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
    });

    banner.innerHTML = `
        <span>${icon} ${label}${reason}</span>
        <button id="shield-dismiss" style="
            background: rgba(255,255,255,0.2);
            border: none;
            color: #fff;
            padding: 4px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
        ">Dismiss</button>
    `;

    document.body.prepend(banner);

    document.getElementById('shield-dismiss').addEventListener('click', () => {
        banner.style.transition = 'opacity 0.3s';
        banner.style.opacity = '0';
        setTimeout(() => banner.remove(), 300);
    });
}
