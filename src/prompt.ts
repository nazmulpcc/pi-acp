import type { ContentBlock } from '@agentclientprotocol/sdk';
import { boundedText, limits } from './limits.js';

export function promptToPi(content: ContentBlock[]) {
  const text: string[] = [];
  const images: { type: 'image'; data: string; mimeType: string }[] = [];
  let textBytes = 0;
  let imageBytes = 0;
  const add = (value: string) => {
    textBytes += Buffer.byteLength(value) + 2;
    if (textBytes > limits.promptBytes) throw new Error('Prompt exceeds text limit');
    text.push(value);
  };
  if (content.length > 1024) throw new Error('Too many prompt blocks');
  for (const block of content) {
    if (block.type === 'text') add(boundedText(block.text, limits.promptBytes, 'prompt text'));
    else if (block.type === 'image') {
      if (!/^image\/[a-z0-9.+-]+$/i.test(block.mimeType) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(block.data)) {
        throw new Error('Invalid inline image');
      }
      imageBytes += Buffer.byteLength(block.data);
      if (imageBytes > limits.imageBytes) throw new Error('Prompt exceeds image limit');
      images.push({ type: 'image', data: block.data, mimeType: block.mimeType });
    } else if (block.type === 'resource') {
      if (!('text' in block.resource)) throw new Error('Binary embedded resources are unsupported');
      add(`[Resource: ${boundedText(block.resource.uri, 4096, 'resource URI')}]\n${boundedText(block.resource.text, limits.promptBytes, 'resource text')}`);
    } else if (block.type === 'resource_link') add(`[Resource reference: ${boundedText(block.uri, 4096, 'resource URI')}]`);
    else throw new Error('Unsupported prompt content type');
  }
  if (!text.length && !images.length) throw new Error('Prompt must contain text or an image');
  return { message: text.join('\n\n'), images };
}
