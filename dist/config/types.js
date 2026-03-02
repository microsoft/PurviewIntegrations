"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecutionMode = exports.Activity = void 0;
var Activity;
(function (Activity) {
    Activity[Activity["unknown"] = 0] = "unknown";
    Activity[Activity["uploadText"] = 1] = "uploadText";
    Activity[Activity["uploadFile"] = 2] = "uploadFile";
    Activity[Activity["downloadText"] = 3] = "downloadText";
    Activity[Activity["downloadFile"] = 4] = "downloadFile";
})(Activity || (exports.Activity = Activity = {}));
var ExecutionMode;
(function (ExecutionMode) {
    ExecutionMode["evaluateInline"] = "evaluateInline";
    ExecutionMode["evaluateOffline"] = "evaluateOffline";
})(ExecutionMode || (exports.ExecutionMode = ExecutionMode = {}));
//# sourceMappingURL=types.js.map