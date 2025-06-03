import {
    extension_settings,
    getContext,
} from "../../../extensions.js";

import {
    saveSettingsDebounced,
    setEditedMessageId,
    generateQuietPrompt,
    is_send_press,
    substituteParamsExtended,
    eventSource,
    event_types,
} from "../../../../script.js";

import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { getMessageTimeStamp } from '../../../RossAscends-mods.js';
import { MacrosParser } from '../../../macros.js';
import { is_group_generating, selected_group } from '../../../group-chats.js';

const extensionName = "Sillytavern-CYOA";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const defaultSettings = {
    enabled: false,
    auto_generate: false,
    dynamic_timeout: true,
    llm_prompt: `Stop the roleplay now and provide a response with {{suggestionNumber}} brief distinct single-sentence suggestions for the next story beat on {{user}} perspective. Ensure each suggestion aligns with its corresponding description:
1. Eases tension and improves the protagonist's situation
2. Creates or increases tension and worsens the protagonist's situation
3. Leads directly but believably to a wild twist or super weird event
4. Slowly moves the story forward without ending the current scene
5. Pushes the story forward, potentially ending the current scene if feasible

Each suggestion surrounded by \`<suggestion>\` tags. E.g:
<suggestion>suggestion_1</suggestion>
<suggestion>suggestion_2</suggestion>
...

Do not include any other content in your response.`,
    llm_prompt_impersonate: `[Event Direction for the next story beat on {{user}} perspective: \`{{suggestionText}}\`]
[Based on the expected events, write the user response]`,
    apply_wi_an: true,
    num_responses: 5,
    response_length: 500,
};
let inApiCall = false;
let lastProcessedMessageId = "";

/**
 * Extension verification
 */
function verifyExtension() {
    console.log('CYOA Extension: Running verification checks...');

    // Check if imported functions are available
    const importedFunctions = {
        getContext,
        generateQuietPrompt,
        saveSettingsDebounced,
        substituteParamsExtended,
        eventSource,
        event_types
    };

    const missingFunctions = Object.entries(importedFunctions)
        .filter(([name, fn]) => typeof fn === 'undefined')
        .map(([name]) => name);

    if (missingFunctions.length > 0) {
        console.error('CYOA Extension: Missing required imports:', missingFunctions);
        return false;
    }

    // Check if jQuery is available
    if (typeof $ === 'undefined') {
        console.error('CYOA Extension: jQuery not available');
        return false;
    }

    // Check if extension_settings is available
    if (typeof extension_settings === 'undefined') {
        console.error('CYOA Extension: extension_settings not available');
        return false;
    }

    console.log('CYOA Extension: All verification checks passed');
    return true;
}

/**
 * Utility function to wait until a condition is met
 * @param {Function} condition - Function that returns true when condition is met
 * @param {number} timeout - Maximum time to wait in milliseconds
 * @param {number} interval - Check interval in milliseconds
 * @returns {Promise}
 */
function waitUntilCondition(condition, timeout = 30000, interval = 100) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();

        const check = () => {
            if (condition()) {
                resolve();
            } else if (Date.now() - startTime > timeout) {
                reject(new Error('Timeout waiting for condition'));
            } else {
                setTimeout(check, interval);
            }
        };

        check();
    });
}

/**
 * Calculates dynamic timeout based on response length
 * @param {string} messageText - The character's response text
 * @returns {number} Timeout in milliseconds
 */
function calculateDynamicTimeout(messageText) {
    if (!messageText) return 1000; // Default 1 second if no text

    const messageLength = messageText.length;
    const wordsPerMinute = 200; // Average reading speed
    const millisecondsPerWord = (60 * 1000) / wordsPerMinute; // 300ms per word
    const wordCount = messageText.split(/\s+/).length;

    // Calculate reading time in milliseconds
    let readingTime = wordCount * millisecondsPerWord;

    // Add base processing time
    const baseTime = 1500; // 1.5 seconds base

    // Scale with message length but cap it
    const lengthBasedTime = Math.min(messageLength * 10, 5000); // Max 5 seconds for length

    // Combine all factors
    const totalTimeout = baseTime + readingTime + lengthBasedTime;

    // Cap between 2 and 15 seconds
    const finalTimeout = Math.max(2000, Math.min(totalTimeout, 15000));

    console.log(`CYOA Extension: Dynamic timeout calculation - Words: ${wordCount}, Length: ${messageLength}, Timeout: ${finalTimeout}ms`);

    return finalTimeout;
}

/**
 * Finds the position to place the popup below the last character message
 * @returns {Object|null} Position object with top and left, or null for center
 */
function findOptimalPopupPosition() {
    const context = getContext();
    const chat = context.chat;

    if (chat.length === 0) return null;

    const lastMessage = chat[chat.length - 1];

    // Find the DOM element for the last message
    const messageId = lastMessage.mesId ?? lastMessage.index ?? chat.length - 1;
    const messageSelectors = [
        `.mes[mesid="${messageId}"]`,
        `.mes:last-child`,
        `#chat .mes:nth-last-child(1)`
    ];

    let messageElement = null;
    for (const selector of messageSelectors) {
        messageElement = $(selector);
        if (messageElement.length > 0) {
            console.log(`CYOA Extension: Found message element using selector: ${selector}`);
            break;
        }
    }

    if (!messageElement || messageElement.length === 0) {
        console.log('CYOA Extension: Could not find message element, using center position');
        return null;
    }

    // Get the position and dimensions of the message
    const messageRect = messageElement[0].getBoundingClientRect();
    const windowHeight = window.innerHeight;
    const windowWidth = window.innerWidth;

    // Calculate position below the message
    const topPosition = messageRect.bottom + window.scrollY + 20; // 20px gap
    const leftPosition = Math.max(20, Math.min(messageRect.left, windowWidth - 700)); // Keep within bounds

    // Check if there's enough space below, otherwise use center
    const spaceBelow = windowHeight - messageRect.bottom;
    if (spaceBelow < 300) { // Not enough space for popup
        console.log('CYOA Extension: Not enough space below message, using center position');
        return null;
    }

    console.log(`CYOA Extension: Positioning popup below message at top: ${topPosition}, left: ${leftPosition}`);

    return {
        top: topPosition,
        left: leftPosition
    };
}

/**
 * Creates and shows the CYOA popup with options
 * @param {Array} suggestions - Array of suggestion strings
 */
function showCYOAPopup(suggestions) {
    // Remove existing popup if any
    $('#cyoa-popup-overlay').remove();

    // Process suggestions to ensure they display well
    const processedSuggestions = suggestions.map(suggestion => {
        // Ensure text doesn't exceed reasonable length for display
        return suggestion.length > 500 ? suggestion.substring(0, 500) + "..." : suggestion;
    });

    // Create popup HTML with drag and resize handles
    const popupHtml = `
        <div id="cyoa-popup-overlay">
            <div id="cyoa-popup">
                <div id="cyoa-popup-header" class="cyoa-drag-handle">
                    <div class="cyoa-drag-icon">⋮⋮</div>
                    <h3 id="cyoa-popup-title">How does the story continue?</h3>
                    <button id="cyoa-popup-close" type="button">&times;</button>
                </div>
                <div id="cyoa-popup-options">
                    ${processedSuggestions.map((suggestion, index) => `
                        <button class="cyoa-popup-option" data-suggestion="${encodeURIComponent(suggestions[index])}" title="Click to select • Right-click to edit">
                            <div class="cyoa-popup-option-number">${index + 1}</div>
                            <div class="cyoa-popup-option-text">${suggestion}</div>
                        </button>
                    `).join('')}
                </div>
                <div class="cyoa-popup-hint">
                    <small><i>💡 Click an option to select it, or right-click to edit it first • Drag by header to move • Drag corners to resize</i></small>
                </div>
                <div class="cyoa-resize-handle cyoa-resize-se"></div>
                <div class="cyoa-resize-handle cyoa-resize-sw"></div>
                <div class="cyoa-resize-handle cyoa-resize-ne"></div>
                <div class="cyoa-resize-handle cyoa-resize-nw"></div>
            </div>
        </div>
    `;

    // Add popup to DOM
    $('body').append(popupHtml);

    // Set initial position (centered)
    const popup = $('#cyoa-popup');
    const windowWidth = $(window).width();
    const windowHeight = $(window).height();
    const popupWidth = Math.min(700, windowWidth * 0.85);
    const popupHeight = Math.min(600, windowHeight * 0.85);

    popup.css({
        'position': 'fixed',
        'width': popupWidth + 'px',
        'height': popupHeight + 'px',
        'left': (windowWidth - popupWidth) / 2 + 'px',
        'top': (windowHeight - popupHeight) / 2 + 'px',
        'max-width': 'none',
        'max-height': 'none'
    });

    // Initialize drag and resize functionality
    initializeDragAndResize();

    // Show popup with fade-in effect
    $('#cyoa-popup-overlay').fadeIn(300);

    // Handle option clicks
    $('.cyoa-popup-option').on('click', async function () {
        const suggestion = decodeURIComponent($(this).data('suggestion'));
        await handleCYOAOptionSelected(suggestion);
        hideCYOAPopup();
    });

    // Handle right-click for edit mode
    $('.cyoa-popup-option').on('contextmenu', function (e) {
        e.preventDefault();
        const suggestion = decodeURIComponent($(this).data('suggestion'));
        handleCYOAEdit(suggestion);
        hideCYOAPopup();
    });

    // Handle close button
    $('#cyoa-popup-close').on('click', hideCYOAPopup);

    // Handle overlay click to close (but not when dragging/resizing)
    $('#cyoa-popup-overlay').on('click', function (e) {
        if (e.target === this && !$(this).data('dragging') && !$(this).data('resizing')) {
            hideCYOAPopup();
        }
    });

    // Handle ESC key to close
    $(document).on('keydown.cyoa-popup', function (e) {
        if (e.key === 'Escape') {
            hideCYOAPopup();
        }
    });
}

/**
 * Initializes drag and resize functionality for the popup
 */
function initializeDragAndResize() {
    const popup = $('#cyoa-popup');
    const overlay = $('#cyoa-popup-overlay');
    const header = $('#cyoa-popup-header');

    let isDragging = false;
    let isResizing = false;
    let dragStart = { x: 0, y: 0 };
    let popupStart = { left: 0, top: 0 };
    let resizeStart = { width: 0, height: 0, x: 0, y: 0, left: 0, top: 0 };
    let resizeDirection = '';

    // Drag functionality
    header.on('mousedown', function (e) {
        if (e.target === $('#cyoa-popup-close')[0]) return; // Don't drag when clicking close button

        isDragging = true;
        overlay.data('dragging', true);

        dragStart.x = e.clientX;
        dragStart.y = e.clientY;

        const popupOffset = popup.offset();
        popupStart.left = popupOffset.left;
        popupStart.top = popupOffset.top;

        header.addClass('cyoa-dragging');
        $('body').addClass('cyoa-user-select-none');

        e.preventDefault();
    });

    // Resize functionality
    $('.cyoa-resize-handle').on('mousedown', function (e) {
        isResizing = true;
        overlay.data('resizing', true);

        resizeDirection = $(this).attr('class').split(' ').find(cls => cls.startsWith('cyoa-resize-'));

        resizeStart.x = e.clientX;
        resizeStart.y = e.clientY;
        resizeStart.width = popup.outerWidth();
        resizeStart.height = popup.outerHeight();

        const popupOffset = popup.offset();
        resizeStart.left = popupOffset.left;
        resizeStart.top = popupOffset.top;

        $('body').addClass('cyoa-user-select-none');
        popup.addClass('cyoa-resizing');

        e.preventDefault();
        e.stopPropagation();
    });

    // Mouse move handler
    $(document).on('mousemove.cyoa-drag-resize', function (e) {
        if (isDragging) {
            const deltaX = e.clientX - dragStart.x;
            const deltaY = e.clientY - dragStart.y;

            const newLeft = popupStart.left + deltaX;
            const newTop = popupStart.top + deltaY;

            // Keep popup within viewport bounds
            const windowWidth = $(window).width();
            const windowHeight = $(window).height();
            const popupWidth = popup.outerWidth();
            const popupHeight = popup.outerHeight();

            const constrainedLeft = Math.max(0, Math.min(newLeft, windowWidth - popupWidth));
            const constrainedTop = Math.max(0, Math.min(newTop, windowHeight - popupHeight));

            popup.css({
                left: constrainedLeft + 'px',
                top: constrainedTop + 'px'
            });
        }

        if (isResizing) {
            const deltaX = e.clientX - resizeStart.x;
            const deltaY = e.clientY - resizeStart.y;

            let newWidth = resizeStart.width;
            let newHeight = resizeStart.height;
            let newLeft = resizeStart.left;
            let newTop = resizeStart.top;

            // Apply resize based on direction
            if (resizeDirection.includes('se')) {
                newWidth = resizeStart.width + deltaX;
                newHeight = resizeStart.height + deltaY;
            } else if (resizeDirection.includes('sw')) {
                newWidth = resizeStart.width - deltaX;
                newHeight = resizeStart.height + deltaY;
                newLeft = resizeStart.left + deltaX;
            } else if (resizeDirection.includes('ne')) {
                newWidth = resizeStart.width + deltaX;
                newHeight = resizeStart.height - deltaY;
                newTop = resizeStart.top + deltaY;
            } else if (resizeDirection.includes('nw')) {
                newWidth = resizeStart.width - deltaX;
                newHeight = resizeStart.height - deltaY;
                newLeft = resizeStart.left + deltaX;
                newTop = resizeStart.top + deltaY;
            }

            // Enforce minimum dimensions
            const minWidth = 300;
            const minHeight = 200;
            const maxWidth = $(window).width() - 20;
            const maxHeight = $(window).height() - 20;

            newWidth = Math.max(minWidth, Math.min(newWidth, maxWidth));
            newHeight = Math.max(minHeight, Math.min(newHeight, maxHeight));

            // Adjust position if size constraints changed the dimensions
            if (resizeDirection.includes('w') && newWidth === minWidth) {
                newLeft = resizeStart.left + (resizeStart.width - minWidth);
            }
            if (resizeDirection.includes('n') && newHeight === minHeight) {
                newTop = resizeStart.top + (resizeStart.height - minHeight);
            }

            // Keep popup within viewport
            newLeft = Math.max(0, Math.min(newLeft, $(window).width() - newWidth));
            newTop = Math.max(0, Math.min(newTop, $(window).height() - newHeight));

            popup.css({
                width: newWidth + 'px',
                height: newHeight + 'px',
                left: newLeft + 'px',
                top: newTop + 'px'
            });
        }
    });

    // Mouse up handler
    $(document).on('mouseup.cyoa-drag-resize', function () {
        if (isDragging || isResizing) {
            isDragging = false;
            isResizing = false;

            overlay.removeData('dragging resizing');
            header.removeClass('cyoa-dragging');
            popup.removeClass('cyoa-resizing');
            $('body').removeClass('cyoa-user-select-none');
        }
    });

    // Handle overlay click to close
    $('#cyoa-popup-overlay').on('click', function (e) {
        if (e.target === this) {
            hideCYOAPopup();
        }
    });

    // Handle ESC key to close
    $(document).on('keydown.cyoa-popup', function (e) {
        if (e.key === 'Escape') {
            hideCYOAPopup();
        }
    });
}

/**
 * Hides the CYOA popup
 */
function hideCYOAPopup() {
    $('#cyoa-popup-overlay').fadeOut(300, function () {
        $(this).remove();
    });

    // Clean up event handlers
    $(document).off('keydown.cyoa-popup');
    $(document).off('mousemove.cyoa-drag-resize');
    $(document).off('mouseup.cyoa-drag-resize');
    $('body').removeClass('cyoa-user-select-none');
}

/**
 * Handles when a CYOA option is selected for editing
 * @param {string} suggestion - The suggestion text to edit
 */
function handleCYOAEdit(suggestion) {
    const inputTextarea = document.querySelector('#send_textarea');
    if (!(inputTextarea instanceof HTMLTextAreaElement)) {
        return;
    }

    // Put the suggestion text directly in the input for editing
    inputTextarea.value = suggestion;
    inputTextarea.dispatchEvent(new Event('input', { bubbles: true }));

    // Focus the textarea for immediate editing
    inputTextarea.focus();

    toastr.info('CYOA: Option copied to input for editing');
}

/**
 * Handles when a CYOA option is selected
 * @param {string} suggestion - The selected suggestion text
 */
async function handleCYOAOptionSelected(suggestion) {
    await waitForGeneration();

    // Sleep for 250ms before continuing
    await new Promise(resolve => setTimeout(resolve, 250));

    const inputTextarea = document.querySelector('#send_textarea');
    if (!(inputTextarea instanceof HTMLTextAreaElement)) {
        return;
    }

    let impersonatePrompt = extension_settings[extensionName]?.llm_prompt_impersonate || '';
    impersonatePrompt = substituteParamsExtended(String(extension_settings[extensionName]?.llm_prompt_impersonate), { suggestionText: suggestion });

    const quiet_prompt = `/impersonate await=true ${impersonatePrompt}`;
    inputTextarea.value = quiet_prompt;

    inputTextarea.dispatchEvent(new Event('input', { bubbles: true }));

    const sendButton = document.querySelector('#send_but');
    if (sendButton instanceof HTMLElement) {
        sendButton.click();
    }
}

/**
 * Parses the CYOA response and returns the suggestions array
 * @param {string} response
 * @returns {Array|null} array of suggestions or null if none found
 */
function parseResponse(response) {
    console.log('CYOA Extension: Parsing response:', response?.substring(0, 500) + '...');

    const suggestions = [];

    // Try multiple parsing strategies

    // Strategy 1: <suggestion> tags (primary)
    const suggestionTagRegex = /<suggestion[^>]*>(.+?)<\/suggestion>/gis;
    let match;
    while ((match = suggestionTagRegex.exec(response)) !== null) {
        const suggestion = match[1].trim();
        if (suggestion) {
            suggestions.push(suggestion);
        }
    }

    if (suggestions.length > 0) {
        console.log('CYOA Extension: Found suggestions using <suggestion> tags:', suggestions);
        return suggestions;
    }

    // Strategy 2: Numbered list patterns
    const numberedPatterns = [
        /^\s*\d+\.\s*(.+)$/gm,  // "1. suggestion"
        /^\s*\d+\)\s*(.+)$/gm,  // "1) suggestion"
        /^\s*\d+:\s*(.+)$/gm,   // "1: suggestion"
        /^\s*\d+\s*-\s*(.+)$/gm // "1 - suggestion"
    ];

    for (const pattern of numberedPatterns) {
        const matches = [...response.matchAll(pattern)];
        if (matches.length > 0) {
            const foundSuggestions = matches.map(m => m[1].trim()).filter(s => s.length > 0);
            if (foundSuggestions.length > 0) {
                console.log('CYOA Extension: Found suggestions using numbered pattern:', foundSuggestions);
                return foundSuggestions;
            }
        }
    }

    // Strategy 3: Line-by-line with filters
    const lines = response.split('\n')
        .map(line => line.trim())
        .filter(line => {
            // Filter out empty lines, very short lines, and common non-suggestion patterns
            return line.length > 10 &&
                !line.toLowerCase().includes('suggestion') &&
                !line.toLowerCase().includes('response') &&
                !line.toLowerCase().includes('option') &&
                !line.match(/^[<>\[\]{}()]+$/) &&
                !line.toLowerCase().startsWith('here') &&
                !line.toLowerCase().startsWith('i ') &&
                line.includes(' '); // Must contain at least one space (multiple words)
        });

    if (lines.length > 0) {
        // Take up to the number of expected responses
        const expectedCount = extension_settings[extensionName]?.num_responses || 5;
        const lineSuggestions = lines.slice(0, expectedCount);
        console.log('CYOA Extension: Found suggestions using line parsing:', lineSuggestions);
        return lineSuggestions;
    }

    console.log('CYOA Extension: No suggestions found in response');
    return null;
}

async function waitForGeneration() {
    try {
        // Wait for group to finish generating
        if (selected_group) {
            await waitUntilCondition(() => is_group_generating === false, 1000, 10);
        }
        // Wait for the send button to be released
        waitUntilCondition(() => is_send_press === false, 30000, 100);
    } catch {
        console.debug('Timeout waiting for is_send_press');
        return;
    }
}
/**
 * Handles the CYOA response generation
 * @returns
 */
async function requestCYOAResponses() {
    const context = getContext();
    const chat = context.chat;

    try {
        console.log('CYOA Extension: Requesting CYOA responses...');

        // no characters or group selected
        if (!context.groupId && context.characterId === undefined) {
            console.log('CYOA Extension: No character or group selected');
            return;
        }

        // Currently summarizing or frozen state - skip
        if (inApiCall) {
            console.log('CYOA Extension: Already in API call, skipping');
            return;
        }

        // No new messages - do nothing
        // if (chat.length === 0 || (lastMessageId === chat.length && getStringHash(chat[chat.length - 1].mes) === lastMessageHash)) {
        if (chat.length === 0) {
            console.log('CYOA Extension: No messages in chat');
            return;
        }

        inApiCall = true;

        await waitForGeneration();

        toastr.info('CYOA: Generating response...');
        const prompt = extension_settings[extensionName]?.llm_prompt || defaultSettings.llm_prompt || "";
        const useWIAN = extension_settings[extensionName]?.apply_wi_an || defaultSettings.apply_wi_an;
        const responseLength = extension_settings[extensionName]?.response_length || defaultSettings.response_length;

        console.log('CYOA Extension: Calling generateQuietPrompt with prompt:', prompt.substring(0, 100) + '...');

        //  generateQuietPrompt(quiet_prompt, quietToLoud, skipWIAN, quietImage = null, quietName = null, responseLength = null, noContext = false)
        const response = await generateQuietPrompt(prompt, false, !useWIAN, null, "Suggestion List", responseLength);

        console.log('CYOA Extension: Received response:', response?.substring(0, 100) + '...');

        const suggestions = parseResponse(response);
        if (!suggestions || suggestions.length === 0) {
            console.error('CYOA Extension: Failed to parse response or no suggestions found');
            toastr.error('CYOA: Failed to parse response');
            return;
        }

        showCYOAPopup(suggestions);
        toastr.success('CYOA: Options generated successfully');
        console.log('CYOA Extension: Successfully generated and displayed CYOA options');
    } catch (error) {
        console.error('CYOA generation error:', error);
        toastr.error('CYOA: Failed to generate options');
    } finally {
        inApiCall = false;
    }
}

/**
 * Removes the last CYOA message from the chat (if any)
 * @param {getContext.chat} chat
 */
function removeLastCYOAMessage(chat = getContext().chat) {
    let lastMessage = chat[chat.length - 1];
    if (!lastMessage?.extra || lastMessage?.extra?.model !== 'cyoa') {
        return;
    }

    const target = $('#chat').find(`.mes[mesid=${lastMessage.mesId}]`);
    if (target.length === 0) {
        return;
    }

    setEditedMessageId(lastMessage.mesId);
    target.find('.mes_edit_delete').trigger('click', { fromSlashCommand: true });
}

/**
 * Checks if auto-generation should be triggered for the given message
 * @param {Object} messageData - Optional message data
 * @returns {boolean}
 */
function shouldAutoGenerate(messageData = null) {
    const context = getContext();
    const chat = context.chat;

    console.log('CYOA Extension: Checking auto-generation conditions...');

    // Check if auto-generation is enabled
    const autoGenEnabled = extension_settings[extensionName]?.auto_generate;
    console.log('CYOA Extension: Auto-generation enabled:', autoGenEnabled);
    if (!autoGenEnabled) {
        return false;
    }

    // No characters or group selected
    if (!context.groupId && context.characterId === undefined) {
        console.log('CYOA Extension: No character or group selected');
        return false;
    }

    // No messages in chat
    if (chat.length === 0) {
        console.log('CYOA Extension: No messages in chat');
        return false;
    }

    const lastMessage = chat[chat.length - 1];

    // Create a unique identifier for the message using multiple properties
    const messageId = lastMessage.mesId ?? lastMessage.index ?? chat.length - 1;
    const messageIdentifier = `${messageId}_${lastMessage.is_user}_${lastMessage.mes?.substring(0, 50)}`;

    console.log('CYOA Extension: Last message:', {
        mesId: lastMessage.mesId,
        index: lastMessage.index,
        chatIndex: chat.length - 1,
        identifier: messageIdentifier,
        is_user: lastMessage.is_user,
        is_system: lastMessage.is_system,
        model: lastMessage?.extra?.model,
        messageLength: lastMessage.mes?.length || 0
    });

    // Check if we already processed this message using our identifier
    if (lastProcessedMessageId === messageIdentifier) {
        console.log('CYOA Extension: Message already processed:', lastProcessedMessageId);
        return false;
    }

    // Only auto-generate for character messages (not user messages or system messages)
    if (lastMessage.is_user === true || lastMessage.is_system === true) {
        console.log('CYOA Extension: Skipping user/system message', {
            is_user: lastMessage.is_user,
            is_system: lastMessage.is_system,
            name: lastMessage.name
        });
        return false;
    }

    // Make sure this is actually a character message
    if (!lastMessage.name || lastMessage.name.trim() === '') {
        console.log('CYOA Extension: Message has no character name');
        return false;
    }

    // For extra safety, check if the name matches the selected character name
    if (context.characterId !== undefined) {
        const characterName = context.characters.find(c => c.avatar === context.characterId)?.name;
        if (characterName && lastMessage.name !== characterName) {
            console.log('CYOA Extension: Message name does not match selected character');
            return false;
        }
    }

    // Don't generate on the first message in the chat history
    if (chat.length === 1) {
        console.log('CYOA Extension: Skipping first message in chat history');
        return false;
    }

    // Don't generate on latest message if there's only one character message
    const characterMessages = chat.filter(msg => !msg.is_user && !msg.is_system);
    if (characterMessages.length === 1) {
        console.log('CYOA Extension: Skipping generation since this is the only character message');
        return false;
    }

    // Don't auto-generate if the last message is already a CYOA message
    if (lastMessage?.extra?.model === 'cyoa') {
        console.log('CYOA Extension: Last message is already CYOA');
        return false;
    }

    // Don't auto-generate if we're currently in an API call
    if (inApiCall) {
        console.log('CYOA Extension: Already in API call, skipping');
        return false;
    }

    console.log('CYOA Extension: All conditions passed, auto-generating');
    return true;
}

/**
 * Event handler for message reception that triggers auto-generation
 * @param {Object} messageData 
 */
async function onMessageReceived(messageData) {
    console.log('CYOA Extension: Message received event triggered', messageData);

    // This is an important additional check - make sure we're really dealing with a character message
    // Sometimes the event can trigger for system messages or user messages
    if (messageData && messageData.is_user === true) {
        console.log('CYOA Extension: Ignoring user message in message handler');
        return;
    }

    if (!shouldAutoGenerate(messageData)) {
        console.log('CYOA Extension: Auto-generation conditions not met');
        return;
    }

    console.log('CYOA Extension: Auto-generation triggered');
    const context = getContext();
    const lastMessage = context.chat[context.chat.length - 1];

    // Create identifier for tracking
    const messageId = lastMessage.mesId ?? lastMessage.index ?? context.chat.length - 1;
    const messageIdentifier = `${messageId}_${lastMessage.is_user}_${lastMessage.mes?.substring(0, 50)}`;
    lastProcessedMessageId = messageIdentifier;

    // Calculate dynamic timeout based on message length
    const messageText = lastMessage.mes || '';
    const useDynamicTimeout = extension_settings[extensionName]?.dynamic_timeout ?? true;
    const dynamicTimeout = useDynamicTimeout ? calculateDynamicTimeout(messageText) : 2000; // Default 2 seconds if disabled

    console.log(`CYOA Extension: ${useDynamicTimeout ? 'Using dynamic timeout' : 'Using fixed timeout'} - ${dynamicTimeout}ms`);

    // Show notification about upcoming options
    toastr.info(`CYOA: Options will appear in ${Math.round(dynamicTimeout / 1000)}s...`, '', { timeOut: dynamicTimeout });

    // Wait for the dynamic timeout to allow reading the character response
    setTimeout(async () => {
        try {
            await requestCYOAResponses();
        } catch (error) {
            console.error('CYOA auto-generation failed:', error);
        }
    }, dynamicTimeout);
}

/**
 * Alternative event handler for chat changes
 */
async function onChatChanged() {
    console.log('CYOA Extension: Chat changed event triggered');

    // Reset the processed message ID when chat changes
    lastProcessedMessageId = "";
    console.log('CYOA Extension: Reset processed message ID due to chat change');

    // Use a small delay to ensure the chat is fully updated
    await new Promise(resolve => setTimeout(resolve, 200));

    if (!shouldAutoGenerate()) {
        return;
    }

    console.log('CYOA Extension: Auto-generation triggered from chat change');
    const context = getContext();
    const lastMessage = context.chat[context.chat.length - 1];

    // Create identifier for tracking
    const messageId = lastMessage.mesId ?? lastMessage.index ?? context.chat.length - 1;
    const messageIdentifier = `${messageId}_${lastMessage.is_user}_${lastMessage.mes?.substring(0, 50)}`;
    lastProcessedMessageId = messageIdentifier;

    // Calculate dynamic timeout based on message length
    const messageText = lastMessage.mes || '';
    const useDynamicTimeout = extension_settings[extensionName]?.dynamic_timeout ?? true;
    const dynamicTimeout = useDynamicTimeout ? calculateDynamicTimeout(messageText) : 2000; // Default 2 seconds if disabled

    console.log(`CYOA Extension: ${useDynamicTimeout ? 'Using dynamic timeout' : 'Using fixed timeout'} - ${dynamicTimeout}ms`);

    // Show notification about upcoming options
    toastr.info(`CYOA: Options will appear in ${Math.round(dynamicTimeout / 1000)}s...`, '', { timeOut: dynamicTimeout });

    // Wait for the dynamic timeout to allow reading the character response
    setTimeout(async () => {
        try {
            await requestCYOAResponses();
        } catch (error) {
            console.error('CYOA auto-generation failed:', error);
        }
    }, dynamicTimeout);
}

/**
 * Periodic check for new messages that might have been missed
 */
function startPeriodicCheck() {
    setInterval(async () => {
        // Only check if auto-generation is enabled
        if (!extension_settings[extensionName]?.auto_generate) {
            return;
        }

        const context = getContext();
        const chat = context.chat;

        // Skip if no chat or no messages
        if (!chat || chat.length === 0) {
            return;
        }

        const lastMessage = chat[chat.length - 1];

        // Create identifier for tracking
        const messageId = lastMessage.mesId ?? lastMessage.index ?? chat.length - 1;
        const messageIdentifier = `${messageId}_${lastMessage.is_user}_${lastMessage.mes?.substring(0, 50)}`;

        // Skip if we already processed this message
        if (lastProcessedMessageId === messageIdentifier) {
            return;
        }

        // Skip if it's a user or system message
        if (lastMessage.is_user || lastMessage.is_system) {
            return;
        }

        // Skip if it's a CYOA message
        if (lastMessage?.extra?.model === 'cyoa') {
            return;
        }

        // Skip if no character or group selected
        if (!context.groupId && context.characterId === undefined) {
            return;
        }

        console.log('CYOA Extension: Periodic check found unprocessed message, triggering auto-generation');

        lastProcessedMessageId = messageIdentifier;

        try {
            await requestCYOAResponses();
        } catch (error) {
            console.error('CYOA periodic auto-generation failed:', error);
        }
    }, 2000); // Check every 2 seconds
}

/**
 * Settings Stuff
 */
function loadSettings() {
    try {
        console.log('CYOA Extension: Loading settings...');

        extension_settings[extensionName] = extension_settings[extensionName] || {};
        if (Object.keys(extension_settings[extensionName]).length === 0) {
            Object.assign(extension_settings[extensionName], defaultSettings);
            console.log('CYOA Extension: Applied default settings');
        }

        $('#cyoa_llm_prompt').val(extension_settings[extensionName].llm_prompt).trigger('input');
        $('#cyoa_llm_prompt_impersonate').val(extension_settings[extensionName].llm_prompt_impersonate).trigger('input');
        $('#cyoa_auto_generate').prop('checked', extension_settings[extensionName].auto_generate).trigger('input');
        $('#cyoa_dynamic_timeout').prop('checked', extension_settings[extensionName].dynamic_timeout).trigger('input');
        $('#cyoa_apply_wi_an').prop('checked', extension_settings[extensionName].apply_wi_an).trigger('input');
        $('#cyoa_num_responses').val(extension_settings[extensionName].num_responses).trigger('input');
        $('#cyoa_num_responses_value').text(extension_settings[extensionName].num_responses);
        $('#cyoa_response_length').val(extension_settings[extensionName].response_length).trigger('input');
        $('#cyoa_response_length_value').text(extension_settings[extensionName].response_length);

        console.log('CYOA Extension: Settings loaded successfully');
    } catch (error) {
        console.error('CYOA Extension: Error loading settings:', error);
    }
}

function addEventListeners() {
    $('#cyoa_llm_prompt').on('input', function () {
        extension_settings[extensionName].llm_prompt = $(this).val();
        saveSettingsDebounced();
    });

    $('#cyoa_llm_prompt_impersonate').on('input', function () {
        extension_settings[extensionName].llm_prompt_impersonate = $(this).val();
        saveSettingsDebounced();
    });

    $('#cyoa_auto_generate').on('change', function () {
        extension_settings[extensionName].auto_generate = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#cyoa_dynamic_timeout').on('change', function () {
        extension_settings[extensionName].dynamic_timeout = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#cyoa_apply_wi_an').on('change', function () {
        extension_settings[extensionName].apply_wi_an = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#cyoa_num_responses').on('input', function () {
        const value = $(this).val();
        extension_settings[extensionName].num_responses = Number(value);
        $('#cyoa_num_responses_value').text(value);
        saveSettingsDebounced();
    });

    $('#cyoa_response_length').on('input', function () {
        const value = $(this).val();
        extension_settings[extensionName].response_length = Number(value);
        $('#cyoa_response_length_value').text(value);
        saveSettingsDebounced();
    });
}

// This function is called when the extension is loaded
jQuery(async () => {
    try {
        console.log('CYOA Extension: Starting initialization...');

        // Verify extension before proceeding
        if (!verifyExtension()) {
            console.error('CYOA Extension: Verification failed. Aborting initialization.');
            return;
        }

        //add a delay to possibly fix some conflicts
        await new Promise(resolve => setTimeout(resolve, 900));

        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);

        console.log('CYOA Extension: Settings HTML loaded');

        loadSettings();
        addEventListeners();

        console.log('CYOA Extension: Settings and event listeners initialized');

        // Add regenerate button to Extensions menu
        const addRegenerateButton = () => {
            // Try multiple possible selectors for the Extensions menu
            const extensionMenuSelectors = [
                '#extensionsMenu',
                '#extensions_menu',
                '.extensions_menu',
                '#right-nav-panel .list-group',
                '#extensionsMenuButton + .dropdown-menu'
            ];

            let extensionMenu = null;
            for (const selector of extensionMenuSelectors) {
                extensionMenu = $(selector);
                if (extensionMenu.length > 0) {
                    break;
                }
            }

            if (extensionMenu && extensionMenu.length > 0) {
                const regenerateMenuItem = $(`
                    <li class="list-group-item">
                        <a id="cyoa_regenerate_menu_btn" href="javascript:void(0)" class="extension-button">
                            <i class="fa-solid fa-refresh"></i>
                            <span>Regenerate CYOA Options</span>
                        </a>
                    </li>
                `);
                extensionMenu.append(regenerateMenuItem);

                $('#cyoa_regenerate_menu_btn').on('click', async function (e) {
                    e.preventDefault();
                    await requestCYOAResponses();
                });
            } else {
                // Fallback: Add button to the main toolbar area
                const toolbarSelectors = [
                    '#top-bar',
                    '.toolbar',
                    '#send_form',
                    '#rightSendForm',
                    '.right-panel-content'
                ];

                let toolbar = null;
                for (const selector of toolbarSelectors) {
                    toolbar = $(selector);
                    if (toolbar.length > 0) {
                        break;
                    }
                }

                if (toolbar && toolbar.length > 0) {
                    const regenerateButton = $(`
                        <button id="cyoa_regenerate_toolbar_btn" class="menu_button" type="button" title="Regenerate CYOA Options">
                            <i class="fa-solid fa-refresh"></i>
                            <span>CYOA</span>
                        </button>
                    `);
                    toolbar.first().append(regenerateButton);

                    $('#cyoa_regenerate_toolbar_btn').on('click', async function () {
                        await requestCYOAResponses();
                    });
                }
            }
        };

        // Try to add the button immediately
        addRegenerateButton();

        // Also try again after a delay in case the Extensions menu loads later
        setTimeout(addRegenerateButton, 2000);

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'cyoa',
            callback: async () => {
                await requestCYOAResponses();
                return '';
            },
            helpString: 'Triggers CYOA responses generation.',
        }));

        MacrosParser.registerMacro('suggestionNumber', () => `${extension_settings[extensionName]?.num_responses || defaultSettings.num_responses}`);

        // Listen for character message events only
        console.log('CYOA Extension: Setting up event listeners for auto-generation...');

        // Primary event listener for character messages
        if (event_types.MESSAGE_SENT) {
            // Listen for when the user sends a message, but wait for the character to respond
            eventSource.on(event_types.MESSAGE_SENT, () => {
                // We'll use this event just to track when messages are sent
                // This helps avoid triggering CYOA on user input
                console.log('CYOA Extension: User message sent, waiting for character response');
            });
            console.log('CYOA Extension: MESSAGE_SENT listener registered');
        }

        // This is the main event we'll use to detect character messages after they're done generating
        if (event_types.CHARACTER_MESSAGE_RENDERED) {
            eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageReceived);
            console.log('CYOA Extension: CHARACTER_MESSAGE_RENDERED listener registered');
        } else if (event_types.MESSAGE_RECEIVED) {
            // Fallback to MESSAGE_RECEIVED if CHARACTER_MESSAGE_RENDERED is not available
            eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
            console.log('CYOA Extension: MESSAGE_RECEIVED listener registered');
        }

        // Reset message ID when character or chat changes
        if (event_types.CHARACTER_SELECTED) {
            eventSource.on(event_types.CHARACTER_SELECTED, () => {
                lastProcessedMessageId = "";
                console.log('CYOA Extension: Reset processed message ID due to character change');
            });
            console.log('CYOA Extension: CHARACTER_SELECTED listener registered');
        }

        if (event_types.CHAT_LOADED) {
            eventSource.on(event_types.CHAT_LOADED, () => {
                lastProcessedMessageId = "";
                console.log('CYOA Extension: Reset processed message ID due to chat load');
            });
            console.log('CYOA Extension: CHAT_LOADED listener registered');
        }

        // Note: Removed periodic check and multiple overlapping event listeners
        // to prevent duplicate triggers and conflicts

        // Expose debug functions to window for testing
        window.cyoaDebug = {
            checkAutoGeneration: shouldAutoGenerate,
            forceGenerate: requestCYOAResponses,
            resetMessageId: () => {
                lastProcessedMessageId = -1;
                console.log('CYOA Extension: Manually reset processed message ID');
            },
            getLastProcessedId: () => lastProcessedMessageId,
            getCurrentSettings: () => extension_settings[extensionName],
            testPopup: () => {
                showCYOAPopup(['Test option 1', 'Test option 2', 'Test option 3']);
            },
            testSpacing: () => {
                const testSuggestions = [
                    "Short option text",
                    "Medium length option text that should wrap properly on smaller screens",
                    "Longer option text that definitely needs to wrap and should be displayed correctly with the number indicator not overlapping the text",
                    "Very long text that simulates a complex suggestion with lots of details and should be displayed properly with adequate spacing and no overflow issues",
                    "This is an extremely long option text designed to test edge cases where the text might overflow or cause layout issues."
                ];
                showCYOAPopup(testSuggestions);
                return "Test popup with various text lengths launched";
            }
        };
        console.log('CYOA Extension: Debug functions exposed to window.cyoaDebug');

        console.log('CYOA Extension: Initialization completed successfully');

    } catch (error) {
        console.error('CYOA Extension: Failed to initialize:', error);
        throw error;
    }
});
