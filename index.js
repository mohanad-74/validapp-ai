// Modal Toggle Functions
function openAiAssistantModal() {
    document.getElementById('ai-modal').classList.remove('hidden');
    document.getElementById('ai-error-box').classList.add('hidden');
    document.getElementById('ai-result-box').classList.add('hidden');
}

function closeAiAssistantModal() {
    document.getElementById('ai-modal').classList.add('hidden');
}

// Core AI Action trigger handling CORS and API connectivity
async function handleAiAction(actionType) {
    const errorBox = document.getElementById('ai-error-box');
    const errorMessage = document.getElementById('ai-error-message');
    const resultBox = document.getElementById('ai-result-box');
    
    errorBox.classList.add('hidden');
    resultBox.classList.add('hidden');
    resultBox.innerHTML = '<div class="flex items-center space-x-2 text-indigo-600"><i class="fa-solid fa-spinner fa-spin"></i><span>Analyzing study data securely...</span></div>';
    resultBox.classList.remove('hidden');

    const endpoint = "https://us-central1-validapp-db.cloudfunctions.net/runAiAssistant";
    const apiKey = localStorage.getItem("ai_api_key") || "";

    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ 
                studyId: "study_nerhasilda_75", 
                action: actionType, 
                apiKey: apiKey 
            })
        });

        if (!response.ok) {
            let errorMsg = `Server responded with status ${response.status}`;
            try {
                const errorData = await response.json();
                if (errorData && errorData.error) {
                    errorMsg = errorData.error;
                }
            } catch (e) {
                // Non-JSON fallback response handling
            }
            throw new Error(errorMsg);
        }

        const data = await response.json();
        resultBox.innerHTML = `<strong>Success:</strong><p class="mt-1">${data.result}</p>`;

    } catch (error) {
        console.error("AI Assistant error:", error.message);
        resultBox.classList.add('hidden');
        errorMessage.textContent = error.message || "The AI Assistant is temporarily unavailable. Please try again shortly.";
        errorBox.classList.remove('hidden');
    }
}
