async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;

  addChatMessage(message, true);
  input.value = '';

  // Show typing indicator
  const messages = document.getElementById('chat-messages');
  const typingDiv = document.createElement('div');
  typingDiv.className = 'chat-message bot';
  typingDiv.id = 'typing-indicator';
  typingDiv.innerHTML = `<div class="chat-bubble bot">Thinking...</div>`;
  messages.appendChild(typingDiv);
  messages.scrollTop = messages.scrollHeight;

  try {
    const context = buildContextPrompt();

    const response = await fetch('/.netlify/functions/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message, context })
    });

if (!response.ok) {
  const data = await response.json();
  throw new Error(data.error || `Error: ${response.status}`);
}

    const data = await response.json();
    const reply = data.reply || 'Sorry, I could not generate a response.';

    // Remove typing indicator
    const typingIndicator = document.getElementById('typing-indicator');
    if (typingIndicator) typingIndicator.remove();

    addChatMessage(reply.trim());
  } catch (error) {
    console.error('Chat error:', error);
    const typingIndicator = document.getElementById('typing-indicator');
    if (typingIndicator) typingIndicator.remove();
    addChatMessage('Sorry, I encountered an error. Please check your Claude API key and try again.');
  }
}