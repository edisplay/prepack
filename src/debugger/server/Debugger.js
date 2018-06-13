/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

/* @flow strict-local */

import { BreakpointManager } from "./BreakpointManager.js";
import { BabelNode } from "babel-types";
import type { BabelNodeSourceLocation } from "babel-types";
import invariant from "../common/invariant.js";
import type { DebugChannel } from "./channel/DebugChannel.js";
import { DebugMessage } from "./../common/channel/DebugMessage.js";
import { DebuggerError } from "./../common/DebuggerError.js";
import type {
  DebuggerRequest,
  StackframeArguments,
  ScopesArguments,
  Stackframe,
  Scope,
  VariablesArguments,
  EvaluateArguments,
  SourceData,
  DebuggerConfigArguments,
} from "./../common/types.js";
import type { Realm } from "./../../realm.js";
import { ExecutionContext } from "./../../realm.js";
import { VariableManager } from "./VariableManager.js";
import { SteppingManager } from "./SteppingManager.js";
import type { StoppableObject } from "./StopEventManager.js";
import { StopEventManager } from "./StopEventManager.js";
import {
  EnvironmentRecord,
  GlobalEnvironmentRecord,
  FunctionEnvironmentRecord,
  DeclarativeEnvironmentRecord,
  ObjectEnvironmentRecord,
} from "./../../environment.js";
import { CompilerDiagnostic } from "../../errors.js";
import type { Severity } from "../../errors.js";
import type { SourceFile } from "./../../types.js";
import { getAbsoluteSourcePath, findCommonPrefix } from "./PathNormalizer.js";

export class DebugServer {
  constructor(channel: DebugChannel, realm: Realm, configArgs: DebuggerConfigArguments) {
    this._channel = channel;
    this._realm = realm;
    this._breakpointManager = new BreakpointManager();
    this._variableManager = new VariableManager(realm);
    this._stepManager = new SteppingManager(this._realm, /* default discard old steppers */ false);
    this._stopEventManager = new StopEventManager();
    this._diagnosticSeverity = configArgs.diagnosticSeverity || "FatalError";
    this._findSourcemapPrefix(configArgs.sourceMaps);
    this.waitForRun(undefined);
  }
  // the collection of breakpoints
  _breakpointManager: BreakpointManager;
  // the channel to communicate with the adapter
  _channel: DebugChannel;
  _realm: Realm;
  _variableManager: VariableManager;
  _stepManager: SteppingManager;
  _stopEventManager: StopEventManager;
  _lastExecuted: SourceData;
  // Prefix used to translate relative paths stored in AST nodes into absolute paths given to IDE.
  _sourcemapPrefix: string;
  // Severity at which debugger will break when CompilerDiagnostics are generated. Default is Fatal.
  _diagnosticSeverity: Severity;

  /* Block until adapter says to run
  /* ast: the current ast node we are stopped on
  /* reason: the reason the debuggee is stopping
  */
  waitForRun(loc: void | BabelNodeSourceLocation) {
    let keepRunning = false;
    let request;
    while (!keepRunning) {
      request = this._channel.readIn();
      keepRunning = this.processDebuggerCommand(request, loc);
    }
  }

  // Checking if the debugger needs to take any action on reaching this ast node
  checkForActions(ast: BabelNode) {
    if (this._checkAndUpdateLastExecuted(ast)) {
      let stoppables: Array<StoppableObject> = this._stepManager.getAndDeleteCompletedSteppers(ast);
      let breakpoint = this._breakpointManager.getStoppableBreakpoint(ast);
      if (breakpoint) stoppables.push(breakpoint);
      let reason = this._stopEventManager.getDebuggeeStopReason(ast, stoppables);
      if (reason) {
        invariant(ast.loc && ast.loc.source);
        let absolutePath = this._relativeToAbsolute(ast.loc.source);
        invariant(ast.loc); // To appease flow
        this._channel.sendStoppedResponse(reason, absolutePath, ast.loc.start.line, ast.loc.start.column);
        invariant(ast.loc && ast.loc !== null);
        this.waitForRun(ast.loc);
      }
    }
  }

  // Process a command from a debugger. Returns whether Prepack should unblock
  // if it is blocked
  processDebuggerCommand(request: DebuggerRequest, loc: void | BabelNodeSourceLocation) {
    let requestID = request.id;
    let command = request.command;
    let args = request.arguments;
    // Convert incoming location sources to relative paths in order to match internal representation of filenames.
    if (loc && loc.source) loc.source = this._absoluteToRelative(loc.source);
    if (args.kind === "breakpoint") {
      for (let bp of args.breakpoints) {
        bp.filePath = this._absoluteToRelative(bp.filePath);
      }
    }

    switch (command) {
      case DebugMessage.BREAKPOINT_ADD_COMMAND:
        invariant(args.kind === "breakpoint");
        this._breakpointManager.addBreakpointMulti(args.breakpoints);
        this._channel.sendBreakpointsAcknowledge(DebugMessage.BREAKPOINT_ADD_ACKNOWLEDGE, requestID, args);
        break;
      case DebugMessage.BREAKPOINT_REMOVE_COMMAND:
        invariant(args.kind === "breakpoint");
        this._breakpointManager.removeBreakpointMulti(args.breakpoints);
        this._channel.sendBreakpointsAcknowledge(DebugMessage.BREAKPOINT_REMOVE_ACKNOWLEDGE, requestID, args);
        break;
      case DebugMessage.BREAKPOINT_ENABLE_COMMAND:
        invariant(args.kind === "breakpoint");
        this._breakpointManager.enableBreakpointMulti(args.breakpoints);
        this._channel.sendBreakpointsAcknowledge(DebugMessage.BREAKPOINT_ENABLE_ACKNOWLEDGE, requestID, args);
        break;
      case DebugMessage.BREAKPOINT_DISABLE_COMMAND:
        invariant(args.kind === "breakpoint");
        this._breakpointManager.disableBreakpointMulti(args.breakpoints);
        this._channel.sendBreakpointsAcknowledge(DebugMessage.BREAKPOINT_DISABLE_ACKNOWLEDGE, requestID, args);
        break;
      case DebugMessage.PREPACK_RUN_COMMAND:
        invariant(args.kind === "run");
        this._onDebuggeeResume();
        return true;
      case DebugMessage.STACKFRAMES_COMMAND:
        invariant(args.kind === "stackframe");
        this.processStackframesCommand(requestID, args, loc);
        break;
      case DebugMessage.SCOPES_COMMAND:
        invariant(args.kind === "scopes");
        this.processScopesCommand(requestID, args);
        break;
      case DebugMessage.VARIABLES_COMMAND:
        invariant(args.kind === "variables");
        this.processVariablesCommand(requestID, args);
        break;
      case DebugMessage.STEPINTO_COMMAND:
        invariant(loc !== undefined);
        this._stepManager.processStepCommand("in", loc);
        this._onDebuggeeResume();
        return true;
      case DebugMessage.STEPOVER_COMMAND:
        invariant(loc !== undefined);
        this._stepManager.processStepCommand("over", loc);
        this._onDebuggeeResume();
        return true;
      case DebugMessage.STEPOUT_COMMAND:
        invariant(loc !== undefined);
        this._stepManager.processStepCommand("out", loc);
        this._onDebuggeeResume();
        return true;
      case DebugMessage.EVALUATE_COMMAND:
        invariant(args.kind === "evaluate");
        this.processEvaluateCommand(requestID, args);
        break;
      default:
        throw new DebuggerError("Invalid command", "Invalid command from adapter: " + command);
    }
    return false;
  }

  processStackframesCommand(requestID: number, args: StackframeArguments, astLoc: void | BabelNodeSourceLocation) {
    let frameInfos: Array<Stackframe> = [];
    let loc = this._getFrameLocation(astLoc ? astLoc : null);
    let fileName = loc.fileName;
    let line = loc.line;
    let column = loc.column;

    // the UI displays the current frame as index 0, so we iterate backwards
    // from the current frame
    for (let i = this._realm.contextStack.length - 1; i >= 0; i--) {
      let frame = this._realm.contextStack[i];
      let functionName = "(anonymous function)";
      if (frame.function && frame.function.__originalName) {
        functionName = frame.function.__originalName;
      }

      let frameInfo: Stackframe = {
        id: this._realm.contextStack.length - 1 - i,
        functionName: functionName,
        fileName: this._relativeToAbsolute(fileName), // Outward facing paths must be absolute.
        line: line,
        column: column,
      };
      frameInfos.push(frameInfo);
      loc = this._getFrameLocation(frame.loc);
      fileName = loc.fileName;
      line = loc.line;
      column = loc.column;
    }
    this._channel.sendStackframeResponse(requestID, frameInfos);
  }

  _getFrameLocation(loc: void | null | BabelNodeSourceLocation): { fileName: string, line: number, column: number } {
    let fileName = "unknown";
    let line = 0;
    let column = 0;
    if (loc && loc.source) {
      fileName = loc.source;
      line = loc.start.line;
      column = loc.start.column;
    }
    return {
      fileName: fileName,
      line: line,
      column: column,
    };
  }

  processScopesCommand(requestID: number, args: ScopesArguments) {
    // first check that frameId is in the valid range
    if (args.frameId < 0 || args.frameId >= this._realm.contextStack.length) {
      throw new DebuggerError("Invalid command", "Invalid frame id for scopes request: " + args.frameId);
    }
    // here the frameId is in reverse order of the contextStack, ie frameId 0
    // refers to last element of contextStack
    let stackIndex = this._realm.contextStack.length - 1 - args.frameId;
    let context = this._realm.contextStack[stackIndex];
    invariant(context instanceof ExecutionContext);
    let scopes = [];
    let lexicalEnv = context.lexicalEnvironment;
    while (lexicalEnv) {
      let scope: Scope = {
        name: this._getScopeName(lexicalEnv.environmentRecord),
        // key used by UI to retrieve variables in this scope
        variablesReference: this._variableManager.getReferenceForValue(lexicalEnv),
        // the variables are easy to retrieve
        expensive: false,
      };
      scopes.push(scope);
      lexicalEnv = lexicalEnv.parent;
    }
    this._channel.sendScopesResponse(requestID, scopes);
  }

  _getScopeName(envRec: EnvironmentRecord): string {
    if (envRec instanceof GlobalEnvironmentRecord) {
      return "Global";
    } else if (envRec instanceof DeclarativeEnvironmentRecord) {
      if (envRec instanceof FunctionEnvironmentRecord) {
        return "Local: " + (envRec.$FunctionObject.__originalName || "anonymous function");
      } else {
        return "Block";
      }
    } else if (envRec instanceof ObjectEnvironmentRecord) {
      return "With";
    } else {
      invariant(false, "Invalid type of environment record");
    }
  }

  processVariablesCommand(requestID: number, args: VariablesArguments) {
    let variables = this._variableManager.getVariablesByReference(args.variablesReference);
    this._channel.sendVariablesResponse(requestID, variables);
  }

  processEvaluateCommand(requestID: number, args: EvaluateArguments) {
    let evalResult = this._variableManager.evaluate(args.frameId, args.expression);
    this._channel.sendEvaluateResponse(requestID, evalResult);
  }

  // actions that need to happen before Prepack can resume
  _onDebuggeeResume() {
    // resets the variable manager
    this._variableManager.clean();
  }

  /*
    Returns whether there are more nodes in the ast.
  */
  _checkAndUpdateLastExecuted(ast: BabelNode): boolean {
    if (ast.loc && ast.loc.source) {
      let filePath = ast.loc.source;
      let line = ast.loc.start.line;
      let column = ast.loc.start.column;
      let stackSize = this._realm.contextStack.length;
      // check if the current location is same as the last one
      if (
        this._lastExecuted &&
        filePath === this._lastExecuted.filePath &&
        line === this._lastExecuted.line &&
        column === this._lastExecuted.column &&
        stackSize === this._lastExecuted.stackSize
      ) {
        return false;
      }
      this._lastExecuted = {
        filePath: filePath,
        line: line,
        column: column,
        stackSize: this._realm.contextStack.length,
      };
      return true;
    }
    return false;
  }

  _findSourcemapPrefix(sourceMaps: Array<SourceFile> | void) {
    if (sourceMaps) {
      // Extract paths to all original source files
      let sourcePaths = [];
      for (let map of sourceMaps) {
        if (map.sourceMapContents) {
          let sources = JSON.parse(map.sourceMapContents).sources;
          for (let source of sources) {
            sourcePaths.push(getAbsoluteSourcePath(map.filePath, source));
          }
        } else {
          // Should probably break out of everything and not attempt to infer a shared prefix if missing some sourcemaps.
        }
      }

      this._sourcemapPrefix = findCommonPrefix(sourcePaths);
    } else {
      this._sourcemapPrefix = "";
    }

    console.log("Prefix", this._sourcemapPrefix);
  }

  _relativeToAbsolute(path: string): string {
    return `${this._sourcemapPrefix}${path}`;
  }

  _absoluteToRelative(path: string): string {
    return path.replace(this._sourcemapPrefix, "");
  }

  /*
    Displays PP error message, then waits for user to run the program to
    continue (similar to a breakpoint).
  */
  handlePrepackError(diagnostic: CompilerDiagnostic) {
    invariant(diagnostic.location);
    // The following constructs the message and stop instruction
    // that is sent to the UI to actually execution.
    let location = diagnostic.location;
    let absoluteSource = "";
    if (location.source !== null) absoluteSource = this._relativeToAbsolute(location.source);
    let message = `${diagnostic.severity} ${diagnostic.errorCode}: ${diagnostic.message}`;
    this._channel.sendStoppedResponse(
      "Diagnostic",
      absoluteSource,
      location.start.line,
      location.start.column,
      message
    );

    // The AST Node's location is needed to satisfy the subsequent stackTrace request.
    this.waitForRun(location);
  }

  // Return whether the debugger should stop on a CompilerDiagnostic of a given severity.
  shouldStopForSeverity(severity: Severity): boolean {
    switch (this._diagnosticSeverity) {
      case "Information":
        return true;
      case "Warning":
        return severity !== "Information";
      case "RecoverableError":
        return severity === "RecoverableError" || severity === "FatalError";
      case "FatalError":
        return severity === "FatalError";
      default:
        invariant(false, "Unexpected severity type");
    }
  }

  shutdown() {
    // clean the channel pipes
    this._channel.shutdown();
  }
}
