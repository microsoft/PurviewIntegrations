"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPayloadsFromFile = createPayloadsFromFile;
const fs = __importStar(require("fs"));
const is_binary_path_1 = __importDefault(require("is-binary-path"));
function createPayloadsFromFile(filePath, config, logger) {
    try {
        const stats = fs.statSync(filePath);
        if (stats.size === 0) {
            logger.warn(`Skipping empty file: ${filePath}`);
            return null;
        }
        const isBinary = (0, is_binary_path_1.default)(filePath);
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
        const chunks = [];
        if (totalSize > config.maxFileBytes) {
            logger.info(`Slicing large file: ${filePath} (${totalSize} bytes) into chunks of max ${config.maxFileBytes} bytes.`);
            for (let i = 0; i < totalSize; i += config.maxFileBytes) {
                chunks.push(contentBuffer.subarray(i, i + config.maxFileBytes));
            }
        }
        else {
            chunks.push(contentBuffer);
        }
        return chunks.map((chunk, index) => {
            let content;
            if (isBinary) {
                content = chunk.toString('base64');
            }
            else {
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
    }
    catch (error) {
        logger.warn(`Could not process file ${filePath}. Error: ${error.message}`);
        return null;
    }
}
//# sourceMappingURL=fileUtils.js.map