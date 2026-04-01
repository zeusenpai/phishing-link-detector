// Load shared API configuration
importScripts('config.js');

// Listen for tab navigation completion
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        
        if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:') || tab.url.startsWith('chrome-extension://')) {
            return;
        }
        
        analyzeUrl(tab.url, tabId);
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "PASSWORD_DETECTED" && sender.tab) {
        // Check if the current tab is suspicious
        chrome.storage.local.get([`result_${sender.tab.id}`], (result) => {
            const data = result[`result_${sender.tab.id}`];
            if (data) {
                const prob = data.final_probability !== undefined ? data.final_probability : (data.phishing_probability || 0);
                if (prob >= 0.70) {
                    chrome.tabs.sendMessage(sender.tab.id, {
                        action: "PASSWORD_ALERT"
                    }).catch(err => console.log("Could not send password alert:", err));
                }
            }
        });
    }
});

async function analyzeUrl(url, tabId) {
    try {
        const response = await fetch(`${API_BASE_URL}/predict`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: url })
        });
        
        if (response.ok) {
            const data = await response.json();
            data.url = url;
            
            chrome.storage.local.set({ 
                [`result_${tabId}`]: data,
                "last_scanned": url,
                "last_result": data
            });

            // Trigger prediction message to content script (always display banner)
            chrome.tabs.sendMessage(tabId, {
                action: "SHOW_WARNING",
                data: data
            }).catch(err => {
                console.log("Could not inject warning message into page:", err);
            });
        }
    } catch (error) {
        console.error("Hybrid Shield Phishing Backend API Error:", error);
    }
}
