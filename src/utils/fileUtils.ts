import * as fs from 'fs';
import isBinaryPath from 'is-binary-path';
import { FilePayload, ActionConfig } from './types';
import { Logger } from './logger';

export function createPayloadsFromFile(filePath: string, config: ActionConfig, logger: Logger): FilePayload[] | null {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size === 0) {
      logger.warn(`Skipping empty file: ${filePath}`);
      return null;
    }

    const isBinary = isBinaryPath(filePath);
    if (isBinary && config.skipBinary) {
      logger.warn(`Skipping binary file: ${filePath}`);
      return null;
    }

    const contentBuffer = fs.readFileSync(filePath);
    const totalSize = contentBuffer.byteLength;

    if (!config.sliceLargeFiles && totalSize > config.maxFileBytes) {
      logger.warn(`Skipping oversized file (slicing disabled): ${filePath} (${totalSize} bytes > ${config.maxFileBytes} bytes)`);
      return null;
    }

    const chunks: Buffer[] = [];
    if (totalSize > config.maxFileBytes) {
      logger.info(`Slicing large file: ${filePath} (${totalSize} bytes) into chunks of max ${config.maxFileBytes} bytes.`);
      for (let i = 0; i < totalSize; i += config.maxFileBytes) {
        chunks.push(contentBuffer.subarray(i, i + config.maxFileBytes));
      }
    } else {
      chunks.push(contentBuffer);
    }

    return chunks.map((chunk, index) => {
      let content: string;
      if (isBinary) {
        content = chunk.toString('base64');
      } else {
        content = chunk.toString('utf8');
        if (config.minify) {
          // Basic minify: just trim whitespace. More complex minification is out of scope.
          content = content.replace(/\s+/g, ' ').trim();
        }
      }

      return {
        filePath,
        content,
        isBinary,
        isSliced: chunks.length > 1,
        sliceIndex: chunks.length > 1 ? index + 1 : undefined,
        totalSlices: chunks.length > 1 ? chunks.length : undefined,
      };
    });
  } catch (error) {
    logger.warn(`Could not process file ${filePath}. Error: ${(error as Error).message}`);
    return null;
  }
}