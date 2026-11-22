// scripts/guidedImpersonatePrefill.js
// Prefill Impersonate: impersonates {{user}} with an optional forced reply start (prefill),
// optionally auto-sends the result so {{char}} responds. Uses the Impersonate (1st Person)
// profile/preset settings.
import { extension_settings, extensionName, debugLog, getPreviousImpersonateInput, setPreviousImpersonateInput, getLastImpersonateResult, setLastImpersonateResult, requestCompletion, shouldUseDirectCall, fillPromptTemplate } from './persistentGuides/guideExports.js'; // Import from central hub

/**
 * Sends the current textarea content as the user's message and triggers {{char}}'s reply,
 * exactly as if the user had pressed Send themselves.
 */
const sendAsUserAndTrigger = async () => {
    const textarea = document.getElementById('send_textarea');
    if (!textarea || textarea.value.trim() === '') {
        debugLog('[PrefillImpersonate] Nothing to send, skipping auto-send.');
        return;
    }
    const context = SillyTavern.getContext();
    if (typeof context.executeSlashCommandsWithOptions !== 'function') {
        console.error('[GuidedGenerations] context.executeSlashCommandsWithOptions not found!');
        return;
    }
    // {{input}} is resolved at execution time, so pipes/quotes in the text are safe.
    await context.executeSlashCommandsWithOptions('/send {{input}} | /setinput | /trigger await=true');
    debugLog('[PrefillImpersonate] Impersonation sent as user and response triggered.');
};

/**
 * Temporarily hooks SillyTavern's final-prompt events so the next real (non-dry-run)
 * generation starts {{user}}'s reply with `prefill`. Works for both text completion
 * (appended after the impersonation line) and chat completion (trailing assistant message).
 * @param {string} prefill Already macro-substituted prefill text.
 * @returns {() => void} Cleanup function that removes the hooks.
 */
const installImpersonatePrefill = (prefill) => {
    const context = SillyTavern.getContext();
    const { eventSource, eventTypes } = context;
    if (!prefill || !eventSource || !eventTypes) return () => {};

    let applied = false;
    const onTextPrompt = (data) => {
        if (applied || !data || data.dryRun || typeof data.prompt !== 'string') return;
        // Non-instruct impersonation ends with "{{user}}:" - keep a space after the colon
        const needsSpace = /:$/.test(data.prompt);
        data.prompt += (needsSpace ? ' ' : '') + prefill;
        applied = true;
        debugLog('[PrefillImpersonate] Prefill appended to text completion prompt.');
    };
    const onChatPrompt = (data) => {
        if (applied || !data || data.dryRun || !Array.isArray(data.chat)) return;
        data.chat.push({ role: 'assistant', content: prefill });
        applied = true;
        debugLog('[PrefillImpersonate] Prefill appended to chat completion messages.');
    };

    eventSource.on(eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, onTextPrompt);
    eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, onChatPrompt);
    return () => {
        eventSource.removeListener(eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, onTextPrompt);
        eventSource.removeListener(eventTypes.CHAT_COMPLETION_PROMPT_READY, onChatPrompt);
    };
};

const guidedImpersonatePrefill = async () => {
    const textarea = document.getElementById('send_textarea');
    if (!textarea) {
        console.error('[GuidedGenerations] Textarea #send_textarea not found.');
        return;
    }
    const settings = extension_settings[extensionName] || {};
    let currentInputText = textarea.value;
    const lastGeneratedText = getLastImpersonateResult(); // Use getter

    // Clicked again while the previous impersonation is still in the input
    if (lastGeneratedText && currentInputText === lastGeneratedText) {
        if (settings.wipeRegenPrefillImpersonate !== false) {
            // Wipe and regenerate as if there were no input
            debugLog('[PrefillImpersonate] Input matches last impersonation; clearing and regenerating with empty input.');
            currentInputText = '';
            textarea.value = '';
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            // Restore what the user had typed before the impersonation
            textarea.value = getPreviousImpersonateInput();
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            return;
        }
    }

    setPreviousImpersonateInput(currentInputText); // Use setter

    // Resolve target profile and preset from settings
    const profileKey = 'profileImpersonate1st';
    const presetKey = 'presetImpersonate1st';
    const profileValue = extension_settings[extensionName]?.[profileKey] ?? '';
    const presetValue = extension_settings[extensionName]?.[presetKey] ?? '';
    const autoSend = settings.autoSendPrefillImpersonate !== false;
    const rawPrefill = settings.prefillImpersonateText ?? '';
    const prefill = rawPrefill ? SillyTavern.getContext().substituteParams(rawPrefill) : '';
    
    // Debug: Log the exact values being retrieved
    debugLog(`[PrefillImpersonate] Profile key: "${profileKey}"`);
    debugLog(`[PrefillImpersonate] Preset key: "${presetKey}"`);
    debugLog(`[PrefillImpersonate] Profile value from settings: "${profileValue}"`);
    debugLog(`[PrefillImpersonate] Preset value from settings: "${presetValue}"`);
    debugLog(`[PrefillImpersonate] All profile settings:`, Object.keys(extension_settings[extensionName] || {}).filter(key => key.startsWith('profile')));
    
    debugLog(`[PrefillImpersonate] Using profile: ${profileValue || 'current'}, preset: ${presetValue || 'none'}`);
    
    // Use user-defined impersonate prompt override
    const promptTemplate = settings.promptPrefillImpersonate ?? '{{input}}';
    const filledPrompt = fillPromptTemplate(promptTemplate, { input: currentInputText });

    try {
        const useDirectCall = await shouldUseDirectCall(profileValue, presetValue);
        if (useDirectCall) {
            debugLog('[PrefillImpersonate] Requesting direct completion...');
            const completion = await requestCompletion({
                profileName: profileValue,
                presetName: presetValue,
                prompt: filledPrompt,
                debugLabel: 'impersonate:prefill',
                includeChatHistory: true,
                includeIdentityContext: true,
                prefill,
            });

            if (completion && completion.trim() !== '') {
                textarea.value = completion;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                setLastImpersonateResult(completion);
                debugLog('[PrefillImpersonate] Completion received and stored.');
                if (autoSend) await sendAsUserAndTrigger();
            } else {
                debugLog('[PrefillImpersonate] Completion empty, input unchanged.');
            }
        } else {
            const context = SillyTavern.getContext();
            if (typeof context.executeSlashCommandsWithOptions === 'function') {
                const stscriptCommand = `/impersonate await=true ${filledPrompt} |`;
                const removePrefill = installImpersonatePrefill(prefill);
                try {
                    await context.executeSlashCommandsWithOptions(stscriptCommand);
                } finally {
                    removePrefill();
                }
                setLastImpersonateResult(textarea.value);
                debugLog('[PrefillImpersonate] Slash command completed, input stored.');
                if (autoSend) await sendAsUserAndTrigger();
            } else {
                console.error('[GuidedGenerations] context.executeSlashCommandsWithOptions not found!');
            }
        }
    } catch (error) {
        console.error(`[GuidedGenerations] Error executing Prefill Impersonate: ${error}`);
        setLastImpersonateResult(''); // Use setter to clear shared state on error
    }
};

// Export the function
export { guidedImpersonatePrefill };
