/* -*- Mode: js; js-indent-level: 2; indent-tabs-mode: nil; tab-width: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */
/*
 * Copyright 2013 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var runtimeOptions = systemOptions.register(new OptionSet("Runtime Options"));

var traceScope = runtimeOptions.register(new Option("ts", "traceScope", "boolean", false, "trace scope execution"));
var traceExecution = runtimeOptions.register(new Option("tx", "traceExecution", "number", 0, "trace script execution"));
var functionBreak = runtimeOptions.register(new Option("fb", "functionBreak", "number", -1, "Inserts a debugBreak at function index #."));
var compileOnly = runtimeOptions.register(new Option("co", "compileOnly", "number", -1, "Compiles only function number."));
var compileUntil = runtimeOptions.register(new Option("cu", "compileUntil", "number", -1, "Compiles only until a function number."));
var debuggerMode = runtimeOptions.register(new Option("dm", "debuggerMode", "boolean", false, "matches avm2 debugger build semantics"));
var enableVerifier = runtimeOptions.register(new Option("verify", "verify", "boolean", false, "Enable verifier."));

var enableInlineCaching = runtimeOptions.register(new Option("ic", "inlineCaching", "boolean", false, "Enable inline caching."));
var traceInlineCaching = runtimeOptions.register(new Option("tic", "traceInlineCaching", "boolean", false, "Trace inline caching execution."));

var compilerEnableExceptions = runtimeOptions.register(new Option("cex", "exceptions", "boolean", false, "Compile functions with catch blocks."));
var compilerMaximumMethodSize = runtimeOptions.register(new Option("cmms", "maximumMethodSize", "number", 4 * 1024, "Compiler maximum method size."));

var jsGlobal = (function() { return this || (1, eval)('this'); })();

var VM_SLOTS = "vm slots";
var VM_LENGTH = "vm length";
var VM_TRAITS = "vm traits";
var VM_BINDINGS = "vm bindings";
var VM_NATIVE_PROTOTYPE_FLAG = "vm native prototype";
var VM_ENUMERATION_KEYS = "vm enumeration keys";
var VM_TOMBSTONE = createEmptyObject();
var VM_OPEN_METHODS = "vm open methods";
var VM_NEXT_NAME = "vm next name";
var VM_NEXT_NAME_INDEX = "vm next name index";
var VM_IS_CLASS = "vm is class";
var VM_OPEN_METHOD_PREFIX = "open_";

var VM_NATIVE_BUILTINS = [Object, Number, Boolean, String, Array, Date, RegExp];

var VM_NATIVE_BUILTIN_SURROGATES = [
  { object: Object, methods: ["toString", "valueOf"] },
  { object: Function, methods: ["toString", "valueOf"] }
];

var VM_NATIVE_BUILTIN_ORIGINALS = "vm originals";

var SAVED_SCOPE_NAME = "$SS";
var PARAMETER_PREFIX = "p";

var $M = [];

/**
 * ActionScript uses a slightly different syntax for regular expressions. Many of these features
 * are handled by the XRegExp library. Here we override the native RegExp.prototype methods with
 * those implemented by XRegExp. This also updates some methods on the String.prototype such as:
 * match, replace and split.
 */
XRegExp.install({ natives: true });

/**
 * Overriden AS3 methods (see hacks.js). This allows you to provide your own JS implementation
 * for AS3 methods.
 */
var VM_METHOD_OVERRIDES = createEmptyObject();

/**
 * We use inline caching to optimize name resolution on objects when we have no type information
 * available. We attach |InlineCache| (IC) objects on bytecode objects. The IC object is a (key,
 * value) tuple where the key usually holds the "shape" of the dynamic object and the value holds
 * the cached resolved qualified name. This is all predicated on assigning sensible "shape" IDs
 * to objects.
 */
var vmNextShapeId = 1;

function defineObjectShape(obj) {
  // TODO: This assertion seems to fail for proxies, investigate.
  // assert (!obj.shape, "Shouldn't already have a shape ID. " + obj.shape);
  defineReadOnlyProperty(obj, "shape", vmNextShapeId ++);
}

/**
 * We use this to give functions unique IDs to help with debugging.
 */
var vmNextFunctionId = 1;

var InlineCache = (function () {
  function inlineCache () {
    this.key = undefined;
    this.value = undefined;
  }
  inlineCache.prototype.update = function (key, value) {
    this.key = key;
    this.value = value;
    return value;
  };
  return inlineCache;
})();

function ic(bc) {
  return bc.ic || (bc.ic = new InlineCache());
}

/**
 * This is used to keep track if we're in a runtime context. For instance, proxies need to
 * know if a proxied operation is triggered by AS3 code or VM code.
 */

var AS = 1, JS = 2;

var RUNTIME_ENTER_LEAVE_STACK = [AS];

function enter(mode) {
  // print("enter " + RUNTIME_ENTER_LEAVE_STACK);
  RUNTIME_ENTER_LEAVE_STACK.push(mode);
}

function leave(mode) {
  // print("leave " + RUNTIME_ENTER_LEAVE_STACK);
  var top = RUNTIME_ENTER_LEAVE_STACK.pop();
  assert (top === mode);
}

function inJS() {
  return RUNTIME_ENTER_LEAVE_STACK.top() === JS;
}

function inAS() {
  return RUNTIME_ENTER_LEAVE_STACK.top() === AS;
}

/**
 * To embed object references in compiled code we index into globally accessible constant table [$C].
 * This table maintains an unique set of object references, each of which holds its own position in
 * the constant table, thus providing for fast lookup. We can also define constants in the JS global
 * scope.
 */

var OBJECT_NAME = "Object Name";
var objectIDs = 0;
function objectConstantName(object) {
  release || assert(object);
  if (object.hasOwnProperty(OBJECT_NAME)) {
    return object[OBJECT_NAME];
  }
  var name, id = objectIDs++;
  if (object instanceof Global) {
    name = "$G" + id;
  } else if (object instanceof Multiname) {
    name = "$M" + id;
  } else if (isClass(object)) {
    name = "$C" + id;
  } else {
    name = "$O" + id;
  }
  Object.defineProperty(object, OBJECT_NAME, {value: name, writable: false, enumerable: false});
  jsGlobal[name] = object;
  return name;
}


function initializeGlobalObject(global) {
  function getEnumerationKeys(obj) {
    if (obj.node && obj.node.childNodes) {
      obj = obj.node.childNodes;
    }
    var keys = [];

    var boxedValue = obj.valueOf();

    // TODO: This is probably broken if the object has overwritten |valueOf|.
    if (typeof boxedValue === "string" || typeof boxedValue === "number") {
      return [];
    }

    if (obj.getEnumerationKeys) {
      return obj.getEnumerationKeys();
    }

    // TODO: Implement fast path for Array objects.
    for (var key in obj) {
      if (isNumeric(key)) {
        keys.push(Number(key));
      } else if (Multiname.isPublicQualifiedName(key)) {
        if (obj[VM_BINDINGS] && obj[VM_BINDINGS].indexOf(key) >= 0) {
          continue;
        }
        keys.push(key.substr(Multiname.PUBLIC_QUALIFIED_NAME_PREFIX.length));
      }
    }
    return keys;
  }

  /**
   * Gets the next name index of an object. Index |zero| is actually not an
   * index, but rather an indicator to start the iteration.
   */
  defineReadOnlyProperty(global.Object.prototype, VM_NEXT_NAME_INDEX, function (index) {
    if (index === 0) {
      /**
       * We're starting a new iteration. Hope that VM_ENUMERATION_KEYS haven't been
       * defined already.
       */
      this[VM_ENUMERATION_KEYS] = getEnumerationKeys(this);
    }

    var keys = this[VM_ENUMERATION_KEYS];

    while (index < keys.length) {
      if (keys[index] !== VM_TOMBSTONE) {
        return index + 1;
      }
      index ++;
    }

    delete this[VM_ENUMERATION_KEYS];
    return 0;
  });

  /**
   * Gets the nextName after the specified |index|, which you would expect to
   * be index + 1, but it's actually index - 1;
   */
  defineReadOnlyProperty(global.Object.prototype, VM_NEXT_NAME, function (index) {
    var keys = this[VM_ENUMERATION_KEYS];
    release || assert(keys && index > 0 && index < keys.length + 1);
    return keys[index - 1];
  });

  /**
   * Surrogates are used to make |toString| and |valueOf| work transparently. For instance, the expression
   * |a + b| should implicitly expand to |a.public$valueOf() + b.public$valueOf()|. Since, we don't want
   * to call |public$valueOf| explicitly we instead patch the |valueOf| property in the prototypes of native
   * builtins to call the |public$valueOf| instead.
   */
  var originals = global[VM_NATIVE_BUILTIN_ORIGINALS] = createEmptyObject();
  VM_NATIVE_BUILTIN_SURROGATES.forEach(function (surrogate) {
    var object = surrogate.object;
    originals[object.name] = createEmptyObject();
    surrogate.methods.forEach(function (originalFunctionName) {
      var originalFunction = object.prototype[originalFunctionName];
      // Save the original method in case |getNative| needs it.
      originals[object.name][originalFunctionName] = originalFunction;
      var overrideFunctionName = Multiname.getPublicQualifiedName(originalFunctionName);
      if (compatibility) {
        // Patch the native builtin with a surrogate.
        global[object.name].prototype[originalFunctionName] = function surrogate() {
          if (this[overrideFunctionName]) {
            return this[overrideFunctionName]();
          }
          return originalFunction.call(this);
        };
      }
    });
  });

  VM_NATIVE_BUILTINS.forEach(function (o) {
    defineReadOnlyProperty(o.prototype, VM_NATIVE_PROTOTYPE_FLAG, true);
  });
}

/**
 * Checks if the specified |obj| is the prototype of a native JavaScript object.
 */
function isNativePrototype(obj) {
  return Object.prototype.hasOwnProperty.call(obj, VM_NATIVE_PROTOTYPE_FLAG)
}

initializeGlobalObject(jsGlobal);

function createNewGlobalObject() {
  var global = null;
  if (inBrowser) {
    var iFrame = document.createElement("iframe");
    iFrame.style.display = "none";
    document.body.appendChild(iFrame);
    global = window.frames[window.frames.length - 1];
  } else {
    global = newGlobal('new-compartment');
  }
  initializeGlobalObject(global);
  return global;
}

function toDouble(x) {
  return Number(x);
}

function toBoolean(x) {
  return !!x;
}

function toUint(x) {
  var obj = x | 0;
  return obj < 0 ? (obj + 4294967296) : obj;
}

function toInt(x) {
  return x | 0;
}

function toString(x) {
  return String(x);
}

/**
 * ActionScript 3 has different behaviour when deciding whether to call
 * toString or valueOf when one operand is a string. Unlike JavaScript,
 * it calls toString if one operand is a string and valueOf otherwise.
 *
 * This sux, but we have to emulate this behaviour because YouTube
 * depends on it.
 */
function add(l, r) {
  if (typeof l === "string" || typeof r === "string") {
    return String(l) + String(r);
  }
  return l + r;
}

function coerce(value, type) {
  if (type.coerce) {
    return type.coerce(value);
  }

  if (isNullOrUndefined(value)) {
    return null;
  }

  if (type.isInstance(value)) {
    return value;
  } else {
    // FIXME throwErrorFromVM needs to be called from within the runtime
    // because it needs access to the domain or the domain has to be
    // aquired through some other mechanism.
    // throwErrorFromVM("TypeError", "Cannot coerce " + obj + " to type " + type);

    // For now just assert false to print the message.
    release || assert(false, "Cannot coerce " + value + " to type " + type);
  }
}

/**
 * Similar to |toString| but returns |null| for |null| or |undefined| instead
 * of "null" or "undefined".
 */
function coerceString(x) {
  if (x === null || x === undefined) {
    return null;
  }
  return String(x);
}

function typeOf(x) {
  // ABC doesn't box primitives, so typeof returns the primitive type even when
  // the value is new'd
  if (x) {
    if (x.constructor === String) {
      return "string"
    } else if (x.constructor === Number) {
      return "number"
    } else if (x.constructor === Boolean) {
      return "boolean"
    } else if (x instanceof XML || x instanceof XMLList) {
      return "xml"
    }
  }
  return typeof x;
}

/**
 * Make an object's properties accessible from AS3. This prefixes all non-numeric
 * properties with the public prefix.
 */
function publicizeProperties(obj) {
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (!Multiname.isPublicQualifiedName(k)) {
      var v = obj[k];
      obj[Multiname.getPublicQualifiedName(k)] = v;
      delete obj[k];
    }
  }
}

function getSlot(obj, index) {
  return obj[obj[VM_SLOTS][index].name];
}

function setSlot(obj, index, value) {
  var binding = obj[VM_SLOTS][index];
  if (binding.const) {
    return;
  }
  var name = binding.name;
  var type = binding.type;
  if (type && type.coerce) {
    obj[name] = type.coerce(value);
  } else {
    obj[name] = value;
  }
}

function nextName(obj, index) {
  return obj[VM_NEXT_NAME](index);
}

function nextValue(obj, index) {
  if (obj.getProperty) {
    return obj.getProperty(obj[VM_NEXT_NAME](index), false);
  }
  return obj[Multiname.getPublicQualifiedName(obj[VM_NEXT_NAME](index))];
}

/**
 * Determine if the given object has any more properties after the specified |index| in the given |obj|
 * and if so, return the next index or |zero| otherwise. If the |obj| has no more properties then continue
 * the search in |obj.__proto__|. This function returns an updated index and object to be used during
 * iteration.
 *
 * the |for (x in obj) { ... }| statement is compiled into the following pseudo bytecode:
 *
 * index = 0;
 * while (true) {
 *   (obj, index) = hasNext2(obj, index);
 *   if (index) { #1
 *     x = nextName(obj, index); #2
 *   } else {
 *     break;
 *   }
 * }
 *
 * #1 If we return zero, the iteration stops.
 * #2 The spec says we need to get the nextName at index + 1, but it's actually index - 1, this caused
 * me two hours of my life that I will probably never get back.
 *
 * TODO: We can't match the iteration order semantics of Action Script, hopefully programmers don't rely on it.
 */
function hasNext2(obj, index) {
  if (obj === null || obj === undefined) {
    return {index: 0, object: null};
  }
  obj = boxValue(obj);
  release || assert(obj);
  release || assert(index >= 0);

  /**
   * Because I don't think hasnext/hasnext2/nextname opcodes are used outside
   * of loops in "normal" ABC code, we can deviate a little for semantics here
   * and leave the prototype-chaining to the |for..in| operator in JavaScript
   * itself, in |obj[VM_NEXT_NAME_INDEX]|. That is, the object pushed onto the
   * stack, if the original object has any more properties left, will _always_
   * be the original object.
   */
  return {index: obj[VM_NEXT_NAME_INDEX](index), object: obj};
}

function getDescendants(obj, mn) {
  if (!isXMLType(obj)) {
    throw "Not XML object in getDescendants";
  }
  return obj.descendants(mn);
}

function checkFilter(value) {
  if (!value.class || !isXMLType(value)) {
    throw "TypeError operand of childFilter not of XML type";
  }
  return value;
}

function Activation(methodInfo) {
  this.methodInfo = methodInfo;
  defineObjectShape(this);
}

var Interface = (function () {
  function Interface(classInfo) {
    var ii = classInfo.instanceInfo;
    release || assert(ii.isInterface());
    this.name = ii.name;
    this.classInfo = classInfo;
  }

  Interface.prototype = {
    toString: function () {
      return "[interface " + this.name + "]";
    },

    isInstance: function (value) {
      if (value === null || typeof value !== "object") {
        return false;
      }

      release || assert(value.class.implementedInterfaces,
                        "No 'implementedInterfaces' map found on class " +
                            value.class);

      var qualifiedName = Multiname.getQualifiedName(this.name);
      return value.class.implementedInterfaces[qualifiedName] !== undefined;
    },

    call: function (v) {
      return v;
    },

    apply: function ($this, args) {
      return args[0];
    }
  };

  return Interface;
})();

/**
 * Scopes are used to emulate the scope stack as a linked list of scopes, rather than a stack. Each
 * scope holds a reference to a scope [object] (which may exist on multiple scope chains, thus preventing
 * us from chaining the scope objects together directly).
 *
 * Scope Operations:
 *
 *  push scope: scope = new Scope(scope, object)
 *  pop scope: scope = scope.parent
 *  get global scope: scope.global
 *  get scope object: scope.object
 *
 * Method closures have a [savedScope] property which is bound when the closure is created. Since we use a
 * linked list of scopes rather than a scope stack, we don't need to clone the scope stack, we can bind
 * the closure to the current scope.
 *
 * The "scope stack" for a method always starts off as empty and methods push and pop scopes on their scope
 * stack explicitly. If a property is not found on the current scope stack, it is then looked up
 * in the [savedScope]. To emulate this we actually wrap every generated function in a closure, such as
 *
 *  function fnClosure(scope) {
 *    return function fn() {
 *      ... scope;
 *    };
 *  }
 *
 * When functions are created, we bind the function to the current scope, using fnClosure.bind(null, this)();
 *
 * Scope Caching:
 *
 * Calls to |findProperty| are very expensive. They recurse all the way to the top of the scope chain and then
 * laterally across other scripts. We optimize this by caching property lookups in each scope using Multiname
 * |id|s as keys. Each Multiname object is given a unique ID when it's constructed. For QNames we only cache
 * string QNames.
 *
 * TODO: This is not sound, since you can add/delete properties to/from with scopes.
 */
var Scope = (function () {
  function scope(parent, object, isWith) {
    this.parent = parent;
    this.object = object;
    this.global = parent ? parent.global : this;
    this.isWith = isWith;
    this.cache = createEmptyObject();
  }

  scope.prototype.findDepth = function findDepth(obj) {
    var current = this;
    var depth = 0;
    while (current) {
      if (current.object === obj) {
        return depth;
      }
      depth ++;
      current = current.parent;
    }
    return -1;
  };

  scope.prototype.findProperty = function findProperty(mn, domain, strict, scopeOnly) {
    release || assert(this.object);
    release || assert(Multiname.isMultiname(mn));
    var obj;
    var cache = this.cache;

    var id = typeof mn === "string" ? mn : mn.id;
    if (!scopeOnly && id && (obj = cache[id])) {
      return obj;
    }

    obj = this.object;
    if (Multiname.isQName(mn)) {
      if (this.isWith) {
        if (obj.hasProperty && obj.hasProperty(mn) ||
            Multiname.getQualifiedName(mn) in obj) {
          return obj;
        }
      } else {
        if (nameInTraits(obj, Multiname.getQualifiedName(mn))) {
          id && (cache[id] = obj);
          return obj;
        }
      }
    } else {
      if (this.isWith) {
        if (obj.hasProperty && obj.hasProperty(mn) ||
            resolveMultiname(obj, mn)) {
          return obj;
        }
      } else {
        if (resolveMultinameInTraits(obj, mn)) {
          id && (cache[id] = obj);
          return obj;
        }
      }
    }

    if (this.parent) {
      obj = this.parent.findProperty(mn, domain, strict, scopeOnly);
      id && (cache[mn.id] = obj);
      return obj;
    }

    if (scopeOnly) {
      return null;
    }

    // If we can't find it still, then look at the domain toplevel.
    var r;
    if ((r = domain.findProperty(mn, strict, true))) {
      return r;
    }

    if (strict) {
      unexpected("Cannot find property " + mn);
    }

    return this.global.object;
  };

  scope.prototype.trace = function () {
    var current = this;
    while (current) {
      print(current.object + (current.object ? " - " + current.object.debugName : ""));
      current = current.parent;
    }
  };

  return scope;
})();

/**
 * Wraps the free method in a closure that passes the dynamic scope object as the
 * first argument and also makes sure that the |asGlobal| object gets passed in as
 * |this| when the method is called with |fn.call(null)|.
 */
function bindFreeMethodScope(methodInfo, scope) {
  var fn = methodInfo.freeMethod;
  if (methodInfo.lastBoundMethod && methodInfo.lastBoundMethod.scope === scope) {
    return methodInfo.lastBoundMethod.boundMethod;
  }
  assert (fn, "There should already be a cached method.");
  var boundMethod;
  var asGlobal = scope.global.object;
  if (!methodInfo.hasOptional() && !methodInfo.needsArguments() && !methodInfo.needsRest()) {
    // Special case the common path.
    switch (methodInfo.parameters.length) {
      case 0:
        boundMethod = function () {
          return fn.call(this === jsGlobal ? asGlobal : this, scope);
        };
        break;
      case 1:
        boundMethod = function (x) {
          return fn.call(this === jsGlobal ? asGlobal : this, scope, x);
        };
        break;
      case 2:
        boundMethod = function (x, y) {
          return fn.call(this === jsGlobal ? asGlobal : this, scope, x, y);
        };
        break;
      case 3:
        boundMethod = function (x, y, z) {
          return fn.call(this === jsGlobal ? asGlobal : this, scope, x, y, z);
        };
        break;
      default:
        // TODO: We can special case more ...
        break;
    }
  }
  if (!boundMethod) {
    Counter.count("Bind Scope - Slow Path");
    boundMethod = function () {
      Array.prototype.unshift.call(arguments, scope);
      var global = (this === jsGlobal ? scope.global.object : this);
      return fn.apply(global, arguments);
    };
  }
  boundMethod.instanceConstructor = boundMethod;
  methodInfo.lastBoundMethod = {
    scope: scope,
    boundMethod: boundMethod
  };
  return boundMethod;
}

var TraitsInfo = (function () {
  function traitsInfo(parent, array) {
    this.parent = parent;
    var traits = this.traits = createEmptyObject();
    if (parent) {
      for (var k in parent.traits) {
        traits[k] = parent.traits[k];
        if (traits[k] instanceof Array) {
          traits[k] = traits[k].slice();
        }
      }
    }
    for (var i = 0; i < array.length; i++) {
      var trait = array[i];
      var traitQn = Multiname.getQualifiedName(trait.name);
      if (trait.isGetter() || trait.isSetter()) {
        if (!traits[traitQn]) {
          traits[traitQn] = [undefined, undefined];
        }
        if (trait.isGetter()) {
          traits[traitQn][0] = trait;
        } else if (trait.isSetter()) {
          traits[traitQn][1] = trait;
        }
      } else {
        traits[traitQn] = trait;
      }
    }
  }
  traitsInfo.prototype.trace = function trace(writer) {
    for (var k in this.traits) {
      var value = this.traits[k];
      if (value instanceof Array) {
        writer.writeLn(k + ": [" + value[0] + ", " + value[1] + "]");
      } else {
        writer.writeLn(k + ": " + value);
      }
    }
  };
  traitsInfo.prototype.getTrait = function getTrait(qn, isSetter) {

  };
  return traitsInfo;
})();

/**
 * Check if a qualified name is in an object's traits.
 */
function nameInTraits(obj, qn) {
  // If the object itself holds traits, try to resolve it. This is true for
  // things like global objects and activations, but also for classes, which
  // both have their own traits and the traits of the Class class.
  if (obj.hasOwnProperty(VM_BINDINGS) && obj.hasOwnProperty(qn)) {
    return true;
  }

  // Else look on the prototype.
  var proto = Object.getPrototypeOf(obj);
  return proto.hasOwnProperty(VM_BINDINGS) && proto.hasOwnProperty(qn);
}

function resolveMultinameInTraits(obj, mn) {
  release || assert(!Multiname.isQName(mn), mn, " already resolved");

  obj = boxValue(obj);

  for (var i = 0, j = mn.namespaces.length; i < j; i++) {
    var qn = mn.getQName(i);
    if (nameInTraits(obj, Multiname.getQualifiedName(qn))) {
      return qn;
    }
  }
  return undefined;
}


/**
 * Resolving a multiname on an object using linear search.
 */
function resolveMultinameUnguarded(obj, mn, traitsOnly) {
  release || assert(Multiname.needsResolution(mn), "Multiname " + mn + " is already resolved.");
  release || assert(!Multiname.isNumeric(mn), "Should not resolve numeric multinames.");
  obj = boxValue(obj);
  var publicQn;

  // Check if the object that we are resolving the multiname on is a JavaScript native prototype
  // and if so only look for public (dynamic) properties. The reason for this is because we cannot
  // overwrite the native prototypes to fit into our trait/dynamic prototype scheme, so we need to
  // work around it here during name resolution.

  var isNative = isNativePrototype(obj);
  for (var i = 0, j = mn.namespaces.length; i < j; i++) {
    var qn = mn.getQName(i);
    if (traitsOnly) {
      if (nameInTraits(obj, Multiname.getQualifiedName(qn))) {
        return qn;
      }
      continue;
    }

    if (mn.namespaces[i].isDynamic()) {
      publicQn = qn;
      if (isNative) {
        break;
      }
    } else if (!isNative) {
      if (Multiname.getQualifiedName(qn) in obj) {
        return qn;
      }
    }
  }
  if (publicQn && !traitsOnly && (Multiname.getQualifiedName(publicQn) in obj)) {
    return publicQn;
  }
  return undefined;
}

function resolveMultiname(obj, mn, traitsOnly) {
  enter(JS);
  var result = resolveMultinameUnguarded(obj, mn, traitsOnly);
  leave(JS);
  return result;
}

function createPublicKeyedClone(source) {
  const visited = new WeakMap();
  function visit(item) {
    if (!item || typeof item !== 'object') {
      return item;
    }
    if (visited.has(item)) {
      return visited.get(item);
    }

    var result = createEmptyObject();
    visited.set(item, result);
    var keys = Object.keys(item);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      result[Multiname.getPublicQualifiedName(key)] = visit(item[key]);
    }
    return result;
  }
  return visit(source);
}

function isNameInObject(qn, obj) {
  if (qn.isAttribute()) {
    for (var i = 0; i < obj.attributes.length; i++) {
      var attr = obj.attributes[i];
      if (attr.name === qn.name) {
        return true;
      }
    }
    return false;
  } else {
    return Multiname.getQualifiedName(qn) in obj;
  }
}

function sliceArguments(args, offset) {
  return Array.prototype.slice.call(args, offset);
}

function callPropertyWithIC(obj, mn, isLex, args, ic) {
  if (typeof obj === "number") {
    obj = boxValue(obj);
  }
  var receiver = isLex ? null : obj;
  assert (obj, "NullReferenceException");
  if (isProxyObject(obj)) {
    return obj[VM_CALL_PROXY](mn, receiver, args);
  }
  var property = getPropertyWithIC(obj, mn, true, ic);
  return property.apply(receiver, args);
}

function callProperty(obj, mn, isLex, args) {
  // Counter.count("callProperty " + mn.name);
  if (typeof obj === "number") {
    obj = boxValue(obj);
  }
  var receiver = isLex ? null : obj;
  assert (obj, "NullReferenceException");
  if (isProxyObject(obj)) {
    return obj[VM_CALL_PROXY](mn, receiver, args);
  }
  var property = getProperty(obj, mn, true);
  return property.apply(receiver, args);
}

function hasProperty(obj, name) {
  obj = boxValue(obj);
  if (obj.hasProperty) {
    return obj.hasProperty(name);
  }
  return resolveName(obj, name) in obj;
}

function getSuper(scope, obj, mn) {
  release || assert(scope instanceof Scope);
  release || assert(obj !== undefined, "getSuper(" + mn + ") on undefined");
  release || assert(Multiname.isMultiname(mn));
  var superClass = scope.object.baseClass;
  release || assert(superClass);
  var superTraitsPrototype = superClass.instanceConstructor.prototype;

  var resolved = mn.isQName() ? mn : resolveMultiname(superTraitsPrototype, mn);
  var value = undefined;

  if (resolved) {
    if (Multiname.isNumeric(resolved) && superTraitsPrototype.indexGet) {
      value = superTraitsPrototype.indexGet(Multiname.getQualifiedName(resolved), value);
    } else {
      // Which class is it really on?
      var qn = Multiname.getQualifiedName(resolved);
      var openMethod = superTraitsPrototype[VM_OPEN_METHODS][qn];
      var superName = superClass.classInfo.instanceInfo.name;

      // If we're getting a method closure on the super class, close the open
      // method now and save it to a mangled name. We can't go through the
      // normal memoizer here because we could be overriding our own method or
      // getting into an infinite loop (getters that access the property
      // they're set to on the same object is bad news).
      if (openMethod) {
        value = obj[superName + " " + qn];
        if (!value) {
          value = obj[superName + " " + qn] = safeBind(openMethod, obj);
        }
      } else {
        var descriptor = Object.getOwnPropertyDescriptor(superTraitsPrototype, qn);
        release || assert(descriptor);
        value = descriptor.get ? descriptor.get.call(obj) : obj[qn];
      }
    }
  }
  return value;
}

function resolveName(obj, name) {
  if (name instanceof Multiname) {
    if (name.namespaces.length > 1) {
      var resolved = resolveMultiname(obj, name);
      if (resolved !== undefined) {
        return Multiname.getQualifiedName(resolved);
      } else {
        return Multiname.getPublicQualifiedName(name.name);
      }
    } else {
      return Multiname.getQualifiedName(name);
    }
  } else if (typeof name === "object") {
    // Call toString() on |mn| object.
    return Multiname.getPublicQualifiedName(String(name));
  } else {
    return name;
  }
}

function resolveNameWithIC(obj, name, ic) {
  var qn;
  if (obj.shape) {
    if (ic.key === obj.shape) {
      qn = ic.value;
    } else {
      if (!ic.key) {
        Counter.count("resolveName: IC Miss");
      }
      ic.key = obj.shape;
      qn = ic.value = resolveName(obj, name);
    }
  } else {
    qn = resolveName(obj, name);
  }
  return qn;
}
function getPropertyWithIC(obj, name, isMethod, ic) {
  if (obj.getProperty) {
    return obj.getProperty(name, isMethod);
  }
  var qn = resolveNameWithIC(obj, name, ic);
  if (obj.indexGet && Multiname.isNumeric(qn)) {
    return obj.indexGet(qn);
  }
  return obj[qn];
}

function getProperty(obj, name, isMethod) {
  if (obj.getProperty) {
    return obj.getProperty(name, isMethod);
  }
  var qn = resolveName(obj, name);
  if (obj.indexGet && Multiname.isNumeric(qn)) {
    return obj.indexGet(qn);
  }
  return obj[qn];
}

function setPropertyWithIC(obj, name, value, ic) {
  if (obj.setProperty) {
    return obj.setProperty(name, value);
  }
  var qn = resolveNameWithIC(obj, name, ic);
  if (obj.indexGet && Multiname.isNumeric(qn)) {
    return obj.indexSet(qn, value);
  }
  obj[qn] = value;
}

function setProperty(obj, name, value) {
  if (obj.setProperty) {
    return obj.setProperty(name, value);
  }
  var qn = resolveName(obj, name);
  if (obj.indexGet && Multiname.isNumeric(qn)) {
    return obj.indexSet(qn, value);
  }
  obj[qn] = value;
}

function deleteProperty(obj, name) {
  if (obj.deleteProperty) {
    return obj.deleteProperty(name);
  }
  var qn = resolveName(obj, name);
  if (obj.indexDelete && Multiname.isNumeric(qn)) {
    return obj.indexDelete(qn);
  }
  /**
   * If we're in the middle of an enumeration, we need to remove the property name
   * from the enumeration keys as well. Setting it to |VM_TOMBSTONE| will cause it
   * to be skipped by the enumeration code.
   */
  if (obj[VM_ENUMERATION_KEYS]) {
    var index = obj[VM_ENUMERATION_KEYS].indexOf(qn);
    if (index >= 0) {
      obj[VM_ENUMERATION_KEYS][index] = VM_TOMBSTONE;
    }
  }
  return delete obj[qn];
}

function setSuper(scope, obj, mn, value) {
  release || assert(obj);
  release || assert(Multiname.isMultiname(mn));
  var superClass = scope.object.baseClass;
  release || assert(superClass);

  var superTraitsPrototype = superClass.instanceConstructor.prototype;
  var resolved = Multiname.isQName(mn) ? mn : resolveMultiname(superTraitsPrototype, mn);

  if (resolved !== undefined) {
    if (Multiname.isNumeric(resolved) && superTraitsPrototype.indexSet) {
      superTraitsPrototype.indexSet(Multiname.getQualifiedName(resolved), value);
    } else {
      var qn = Multiname.getQualifiedName(resolved);
      var descriptor = Object.getOwnPropertyDescriptor(superTraitsPrototype, qn);
      release || assert(descriptor);
      if (descriptor.set) {
        descriptor.set.call(obj, value);
      } else {
        obj[qn] = value;
      }
    }
  } else {
    throw new ReferenceError("Cannot create property " + mn.name +
                             " on " + superClass.debugName);
  }
}

function forEachPublicProperty(obj, fn, self) {
  if (!obj[VM_BINDINGS]) {
    for (var key in obj) {
      fn.call(self, key, obj[key]);
    }
    return;
  }

  for (var key in obj) {
    if (isNumeric(key)) {
      fn.call(self, key, obj[key]);
    } else if (Multiname.isPublicQualifiedName(key) && obj[VM_BINDINGS].indexOf(key) < 0) {
      var name = key.substr(Multiname.PUBLIC_QUALIFIED_NAME_PREFIX.length);
      fn.call(self, name, obj[key]);
    }
  }
}

function wrapJSObject(obj) {
  var wrapper = Object.create(obj);
  for (var i in obj) {
    Object.defineProperty(wrapper, Multiname.getPublicQualifiedName(i), (function (obj, i) {
      return {
        get: function () { return obj[i] },
        set: function (value) { obj[i] = value; },
        enumerable: true
      };
    })(obj, i));
  }
  return wrapper;
}

function isInstanceOf(value, type) {
  /*
  if (type instanceof Class) {
    return value instanceof type.instanceConstructor;
  } else if (typeof type === "function") {
    return value instanceof type;
  } else {
    return false;
  }
  */
  return type.isInstanceOf(value);
}

function asInstance(value, type) {
  return type.isInstance(value) ? value : null;
}

function isInstance(value, type) {
  return type.isInstance(value);
}

function createActivation(methodInfo) {
  return Object.create(methodInfo.activationPrototype);
}

function isClass(obj) {
  assert (obj);
  return Object.hasOwnProperty.call(obj, VM_IS_CLASS);
}

function isTrampoline(fn) {
  assert (fn && typeof fn === "function");
  return fn.isTrampoline;
}

function isMemoizer(fn) {
  assert (fn && typeof fn === "function");
  return fn.isMemoizer;
}

/**
 * Scope object backing for catch blocks.
 */
function CatchScopeObject(domain, trait) {
  if (trait) {
    applyCatchTrait(domain, this, new Scope(null, this), trait);
  }
}

/**
 * Global object for a script.
 */
var Global = (function () {
  function Global(script) {
    this.scriptInfo = script;
    script.global = this;
    applyScriptTraits(script.abc.domain, this, new Scope(null, this), script.traits);
    script.loaded = true;
    defineObjectShape(this);
  }
  Global.prototype.toString = function () {
    return "[object global]";
  };
  Global.prototype.isExecuted = function () {
    return this.scriptInfo.executed;
  };
  Global.prototype.isExecuting = function () {
    return this.scriptInfo.executing;
  };
  Global.prototype.ensureExecuted = function () {
    ensureScriptIsExecuted(this.scriptInfo);
  };
  defineNonEnumerableProperty(Global.prototype, Multiname.getPublicQualifiedName("toString"), function () {
    return this.toString();
  });
  return Global;
})();

/**
 * Checks if the specified method should be compiled. For now we just ignore very large methods.
 */
function shouldCompile(mi) {
  if (!mi.hasBody) {
    return false;
  }
  if (mi.hasExceptions() && !compilerEnableExceptions.value) {
    return false;
  } else if (mi.code.length > compilerMaximumMethodSize.value) {
    return false;
  }
  // Don't compile class and script initializers since they only run once.
  if (mi.isClassInitializer || mi.isScriptInitializer) {
    return false;
  }
  return true;
}

/**
 * Checks if the specified method must be compiled, even if the compiled is not enabled.
 */
function forceCompile(mi) {
  var holder = mi.holder;
  if (holder instanceof ClassInfo) {
    holder = holder.instanceInfo;
  }
  if (holder instanceof InstanceInfo) {
    var packageName = holder.name.namespaces[0].originalURI;
    switch (packageName) {
      case "flash.geom":
      case "flash.events":
        return true;
      default:
        break;
    }
    var className = holder.name.getOriginalName();
    switch (className) {
      // ...
    }
  }
  return false;
}

function createInterpretedFunction(methodInfo, scope, hasDynamicScope) {
  var mi = methodInfo;
  var hasDefaults = false;
  var defaults = mi.parameters.map(function (p) {
    if (p.value !== undefined) {
      hasDefaults = true;
    }
    return p.value;
  });
  var fn;
  if (hasDynamicScope) {
    fn = function (scope) {
      var global = (this === jsGlobal ? scope.global.object : this);
      var args = sliceArguments(arguments, 1);
      if (hasDefaults && args.length < defaults.length) {
        args = args.concat(defaults.slice(args.length - defaults.length));
      }
      return Interpreter.interpretMethod(global, methodInfo, scope, args);
    };
  } else {
    fn = function () {
      var global = (this === jsGlobal ? scope.global.object : this);
      var args = sliceArguments(arguments);
      if (hasDefaults && args.length < defaults.length) {
        args = args.concat(defaults.slice(arguments.length - defaults.length));
      }
      return Interpreter.interpretMethod(global, methodInfo, scope, args);
    };
  }
  fn.instanceConstructor = fn;
  fn.debugName = "Interpreter Function #" + vmNextFunctionId++;
  return fn;
}

var totalFunctionCount = 0;
var compiledFunctionCount = 0;

function createCompiledFunction(methodInfo, scope, hasDynamicScope, breakpoint) {
  var mi = methodInfo;
  var parameters = mi.parameters.map(function (p) {
    return PARAMETER_PREFIX + p.name;
  });

  if (hasDynamicScope) {
    parameters.unshift(SAVED_SCOPE_NAME);
  }

  $M.push(mi);

  var body = Compiler.compileMethod(mi, scope, hasDynamicScope);

  var fnName = mi.name ? Multiname.getQualifiedName(mi.name) : "fn" + compiledFunctionCount;
  if (mi.holder) {
    var fnNamePrefix = "";
    if (mi.holder instanceof ClassInfo) {
      fnNamePrefix = "static$" + mi.holder.instanceInfo.name.getName();
    } else if (mi.holder instanceof InstanceInfo) {
      fnNamePrefix = mi.holder.name.getName();
    } else if (mi.holder instanceof ScriptInfo) {
      fnNamePrefix = "script";
    }
    fnName = fnNamePrefix + "$" + fnName;
  }
  fnName = escapeString(fnName);
  if (mi.verified) {
    fnName += "$V";
  }
  if (compiledFunctionCount == functionBreak.value || breakpoint) {
    body = "{ debugger; \n" + body + "}";
  }
//    if ($DEBUG) {
//      body = '{ try {\n' + body + '\n} catch (e) {window.console.log("error in function ' +
//              fnName + ':" + e + ", stack:\\n" + e.stack); throw e} }';
//    }
  var fnSource = "function " + fnName + " (" + parameters.join(", ") + ") " + body;
  if (traceLevel.value > 1) {
    mi.trace(new IndentingWriter(), mi.abc);
  }
  mi.debugTrace = (function (abc) {
    return function () {
      mi.trace(new IndentingWriter(), abc);
    }
  })(this.abc);
  if (traceLevel.value > 0) {
    print (fnSource);
  }
  // mi.freeMethod = (1, eval)('[$M[' + ($M.length - 1) + '],' + fnSource + '][1]');
  // mi.freeMethod = new Function(parameters, body);
  var fn = new Function("return " + fnSource)();
  fn.debugName = "Compiled Function #" + vmNextFunctionId++;
  return fn;
}

function checkMethodOverrides(methodInfo) {
  if (methodInfo.name) {
    var qn = Multiname.getQualifiedName(methodInfo.name);
    if (qn in VM_METHOD_OVERRIDES) {
      warning("Overriding Method: " + qn);
      return VM_METHOD_OVERRIDES[qn];
    }
  }
}

/**
 * Creates a trampoline function stub which calls the result of a |forward| callback. The forward
 * callback is only executed the first time the trampoline is executed and its result is cached in
 * the trampoline closure.
 */
function makeTrampoline(forward, parameterLength) {
  release || assert (forward && typeof forward === "function");
  return (function trampolineContext() {
    var target = null;
    /**
     * Triggers the trampoline and executes it.
     */
    var trampoline = function execute() {
      Counter.count("Executing Trampoline");
      if (!target) {
        target = forward(trampoline);
        assert (target);
      }
      return target.apply(this, arguments);
    };
    /**
     * Just triggers the trampoline without executing it.
     */
    trampoline.trigger = function trigger() {
      Counter.count("Triggering Trampoline");
      if (!target) {
        target = forward(trampoline);
        assert (target);
      }
    };
    trampoline.isTrampoline = true;
    trampoline.debugName = "Trampoline #" + vmNextFunctionId++;
    // Make sure that the length property of the trampoline matches the trait's number of
    // parameters. However, since we can't redefine the |length| property of a function,
    // we define a new hidden |VM_LENGTH| property to store this value.
    defineReadOnlyProperty(trampoline, VM_LENGTH, parameterLength);
    return trampoline;
  })();
}

function makeMemoizer(qn, target) {
  function memoizer() {
    Counter.count("Runtime: Memoizing");
    assert (!Object.prototype.hasOwnProperty.call(this, "class"));
    if (traceExecution.value >= 3) {
      print("Memoizing: " + qn);
    }
    if (isNativePrototype(this)) {
      Counter.count("Runtime: Method Closures");
      return safeBind(target.value, this);
    }
    if (isTrampoline(target.value)) {
      // If the memoizer target is a trampoline then we need to trigger it before we bind the memoizer
      // target to |this|. Triggering the trampoline will patch the memoizer target but not actually
      // call it.
      target.value.trigger();
    }
    assert (!isTrampoline(target.value), "We should avoid binding trampolines.");
    var mc = null;
    if (isClass(this)) {
      Counter.count("Runtime: Static Method Closures");
      mc = safeBind(target.value, this);
      defineReadOnlyProperty(this, qn, mc);
      return mc;
    }
    if (Object.prototype.hasOwnProperty.call(this, qn)) {
      var pd = Object.getOwnPropertyDescriptor(this, qn);
      if (pd.get) {
        Counter.count("Runtime: Method Closures");
        return safeBind(target.value, this);
      }
      Counter.count("Runtime: Unpatched Memoizer");
      return this[qn];
    }
    mc = safeBind(target.value, this);
    defineReadOnlyProperty(mc, Multiname.getPublicQualifiedName("prototype"), null);
    defineReadOnlyProperty(this, qn, mc);
    return mc;
  }
  Counter.count("Runtime: Memoizers");
  memoizer.isMemoizer = true;
  memoizer.debugName = "Memoizer #" + vmNextFunctionId++;
  return memoizer;
}

/**
 * Creates a function from the specified |methodInfo| that is bound to the given |scope|. If the
 * scope is dynamic (as is the case for closures) the compiler generates an additional prefix
 * parameter for the compiled function named |SAVED_SCOPE_NAME| and then wraps the compiled
 * function in a closure that is bound to the given |scope|. If the scope is not dynamic, the
 * compiler bakes it in as a constant which should be much more efficient. If the interpreter
 * is used, the scope object is passed in every time.
 */
function createFunction(mi, scope, hasDynamicScope, breakpoint) {
  release || assert(!mi.isNative(), "Method should have a builtin: ", mi.name);

  if (mi.freeMethod) {
    release || assert(hasDynamicScope);
    return bindFreeMethodScope(mi, scope);
  }

  var fn;

  if ((fn = checkMethodOverrides(mi))) {
    assert (!hasDynamicScope);
    return fn;
  }

  ensureFunctionIsInitialized(mi);

  totalFunctionCount ++;

  var useInterpreter = false;
  if ((mi.abc.domain.mode === EXECUTION_MODE.INTERPRET || !shouldCompile(mi)) && !forceCompile(mi)) {
    useInterpreter = true;
  }

  if (compileOnly.value >= 0) {
    if (Number(compileOnly.value) !== totalFunctionCount) {
      print("Compile Only Skipping " + totalFunctionCount);
      useInterpreter = true;
    }
  }

  if (compileUntil.value >= 0) {
    if (totalFunctionCount > 1000) {
      print(backtrace());
      print(Runtime.getStackTrace());
    }
    if (totalFunctionCount > compileUntil.value) {
      print("Compile Until Skipping " + totalFunctionCount);
      useInterpreter = true;
    }
  }

  if (useInterpreter) {
    mi.freeMethod = createInterpretedFunction(mi, scope, hasDynamicScope);
  } else {
    compiledFunctionCount++;
    if (compileOnly.value >= 0 || compileUntil.value >= 0) {
      print("Compiling " + totalFunctionCount);
    }
    mi.freeMethod = createCompiledFunction(mi, scope, hasDynamicScope, breakpoint);
  }

  if (hasDynamicScope) {
    return bindFreeMethodScope(mi, scope);
  } else {
    return mi.freeMethod;
  }
}

function ensureFunctionIsInitialized(methodInfo) {
  var mi = methodInfo;

  // We use not having an analysis to mean "not initialized".
  if (!mi.analysis) {
    mi.analysis = new Analysis(mi);

    if (mi.traits) {
      mi.activationPrototype = applyActivationTraits(mi.abc.domain, new Activation(mi), mi.traits);
    }

    // If we have exceptions, make the catch scopes now.
    var exceptions = mi.exceptions;
    for (var i = 0, j = exceptions.length; i < j; i++) {
      var handler = exceptions[i];
      if (handler.varName) {
        var varTrait = Object.create(Trait.prototype);
        varTrait.kind = TRAIT_Slot;
        varTrait.name = handler.varName;
        varTrait.typeName = handler.typeName;
        varTrait.holder = mi;
        handler.scopeObject = new CatchScopeObject(mi.abc.domain, varTrait);
      } else {
        handler.scopeObject = new CatchScopeObject();
      }
    }
  }
}

/**
 * Gets the function associated with a given trait.
 */
function getTraitFunction(trait, scope, natives) {
  release || assert(scope);
  release || assert(trait.isMethod() || trait.isGetter() || trait.isSetter());

  var mi = trait.methodInfo;
  var fn;

  if (mi.isNative()) {
    var md = trait.metadata;
    if (md && md.native) {
      var nativeName = md.native.value[0].value;
      var makeNativeFunction = getNative(nativeName);
      fn = makeNativeFunction && makeNativeFunction(null, scope);
    } else if (md && md.unsafeJSNative) {
      fn = getNative(md.unsafeJSNative.value[0].value);
    } else if (natives) {
      // At this point the native class already had the scope, so we don't
      // need to close over the method again.
      var k = Multiname.getName(mi.name);
      if (trait.isGetter()) {
        fn = natives[k] ? natives[k].get : undefined;
      } else if (trait.isSetter()) {
        fn = natives[k] ? natives[k].set : undefined;
      } else {
        fn = natives[k];
      }
    }
    if (!fn) {
      warning("No native method for: " + trait.kindName() + " " +
        mi.holder.name + "::" + Multiname.getQualifiedName(mi.name));
      return (function (mi) {
        return function () {
          warning("Calling undefined native method: " + trait.kindName() +
            " " + mi.holder.name + "::" +
            Multiname.getQualifiedName(mi.name));
        };
      })(mi);
    }
  } else {
    if (traceExecution.value >= 2) {
      print("Creating Function For Trait: " + trait.holder + " " + trait);
    }
    fn = createFunction(mi, scope);
    assert (fn);
  }
  if (traceExecution.value >= 3) {
    print("Made Function: " + Multiname.getQualifiedName(mi.name));
  }
  return fn;
}

function applyCatchTrait(domain, obj, scope, trait) {
  return applyTraits(domain, obj, scope, null, [trait], null, false);
}

function applyScriptTraits(domain, obj, scope, traits) {
  return applyTraits(domain, obj, scope, null, traits, null, false);
}

function applyActivationTraits(domain, obj, traits) {
  return applyTraits(domain, obj, null, null, traits, null, false);
}

function applyInstanceTraits(domain, obj, scope, base, traits, natives) {
  return applyTraits(domain, obj, scope, base, traits, natives, true);
}

function applyClassTraits(domain, obj, scope, base, traits, natives) {
  return applyTraits(domain, obj, scope, base, traits, natives, true);
}

function makeQualifiedNameTraitMap(traits) {
  var map = createEmptyObject();
  for (var i = 0; i < traits.length; i++) {
    map[Multiname.getQualifiedName(traits[i].name)] = traits[i];
  }
  return map;
}

/**
 * Inherit trait bindings. This is the primary inheritance mechanism, we clone the trait bindings then
 * overwrite them for overrides.
 */
function inheritBindings(obj, base, traits) {
  if (!base) {
    defineNonEnumerableProperty(obj, VM_TRAITS, new TraitsInfo(null, traits));
  } else {
    defineNonEnumerableProperty(obj, VM_TRAITS, new TraitsInfo(base[VM_TRAITS], traits));
  }

  if (!base) {
    defineNonEnumerableProperty(obj, VM_BINDINGS, []);
    defineNonEnumerableProperty(obj, VM_SLOTS, []);
    defineNonEnumerableProperty(obj, VM_OPEN_METHODS, createEmptyObject());
  } else {
    var traitMap = makeQualifiedNameTraitMap(traits);
    var openMethods = createEmptyObject();
    var baseBindings = base[VM_BINDINGS];
    var baseOpenMethods = base[VM_OPEN_METHODS];
    for (var i = 0; i < baseBindings.length; i++) {
      var qn = baseBindings[i];
      // TODO: Make sure we don't add overriden methods as patch targets. This may be
      // broken for getters / setters.
      if (!traitMap[qn] || traitMap[qn].isGetter() || traitMap[qn].isSetter()) {
        var baseBindingDescriptor = Object.getOwnPropertyDescriptor(base, qn);
        Object.defineProperty(obj, qn, baseBindingDescriptor);
        if (Object.prototype.hasOwnProperty.call(baseOpenMethods, qn)) {
          var openMethod = baseOpenMethods[qn];
          openMethods[qn] = openMethod;
          defineNonEnumerableProperty(obj, VM_OPEN_METHOD_PREFIX + qn, openMethod);
          if (openMethod.patchTargets) {
            openMethod.patchTargets.push({object: openMethods, name: qn});
            openMethod.patchTargets.push({object: obj, name: VM_OPEN_METHOD_PREFIX + qn});
          }
        }
      }
    }
    defineNonEnumerableProperty(obj, VM_BINDINGS, base[VM_BINDINGS].slice());
    defineNonEnumerableProperty(obj, VM_SLOTS, base[VM_SLOTS].slice());
    defineNonEnumerableProperty(obj, VM_OPEN_METHODS, openMethods);
  }

  return;
}

function applyTraits(domain, obj, scope, base, traits, natives, methodsNeedMemoizers) {
  assert (domain instanceof Domain, "domain is not a Domain object");

  var traitsInfo = inheritBindings(obj, base, traits);

  // Go through each trait and apply it to the |obj|.

  var baseSlotId = obj[VM_SLOTS].length;
  var nextSlotId = baseSlotId + 1;

  for (var i = 0; i < traits.length; i++) {
    var trait = traits[i];
    var qn = Multiname.getQualifiedName(trait.name);
    if (trait.isSlot() || trait.isConst() || trait.isClass()) {
      if (!trait.slotId) {
        trait.slotId = nextSlotId++;
      }

      if (trait.slotId < baseSlotId) {
        // XXX: Hope we don't throw while doing builtins.
        release || assert(false);
        this.throwErrorFromVM("VerifyError", "Bad slot ID.");
      }

      if (trait.isClass()) {
        if (trait.metadata && trait.metadata.native && domain.allowNatives) {
          trait.classInfo.native = trait.metadata.native;
        }
      }

      var defaultValue = undefined;
      if (trait.isSlot() || trait.isConst()) {
        if (trait.hasDefaultValue) {
          defaultValue = trait.value;
        } else if (trait.typeName) {
          defaultValue = domain.findClassInfo(trait.typeName).defaultValue;
        }
      }
      defineNonEnumerableProperty(obj, qn, defaultValue);
      obj[VM_SLOTS][trait.slotId] = {
        name: qn,
        const: trait.isConst(),
        type: trait.typeName ? domain.getProperty(trait.typeName, false, false) : null,
        trait: trait
      };
    } else if (trait.isMethod() || trait.isGetter() || trait.isSetter()) {
      applyMethodTrait(obj, trait, scope, methodsNeedMemoizers, natives);
    } else {
      release || unexpected(trait);
    }

    obj[VM_BINDINGS].pushUnique(qn);

    if (traceExecution.value >= 3) {
      print("Applied Trait: " + trait + " " + qn);
    }
  }

  return obj;
}

function applyMethodTrait(obj, trait, scope, needsMemoizer, natives) {
  var runtime = this;

  release || assert (!trait.value);
  release || assert (trait.isMethod() || trait.isGetter() || trait.isSetter());
  var qn = Multiname.getQualifiedName(trait.name);

  if (needsMemoizer) {
    release || assert(obj[VM_OPEN_METHODS]);
    if (trait.isMethod()) {
      // Patch the target of the memoizer using a temporary |target| object that is visible to both the trampoline
      // and the memoizer. The trampoline closes over it and patches the target value while the memoizer uses the
      // target value for subsequent memoizations.
      var memoizerTarget = { value: null };
      var trampoline = makeTrampoline(function (self) {
        var fn = getTraitFunction(trait, scope, natives);
        Counter.count("Runtime: Patching Memoizer");
        var patchTargets = self.patchTargets;
        for (var i = 0; i < patchTargets.length; i++) {
          var patchTarget = patchTargets[i];
          if (traceExecution.value >= 3) {
            var oldValue = patchTarget.object[patchTarget.name];
            print("Trampoline: Patching: " + patchTarget.name + " oldValue: " + oldValue);
          }
          patchTarget.object[patchTarget.name] = fn;

        }
        return fn;
      }, trait.methodInfo.parameters.length);

      memoizerTarget.value = trampoline;
      var openMethods = obj[VM_OPEN_METHODS];
      openMethods[qn] = trampoline;
      defineNonEnumerableProperty(obj, VM_OPEN_METHOD_PREFIX + qn, trampoline);

      // TODO: We make the |memoizeMethodClosure| configurable since it may be
      // overridden by a derived class. Only do this non final classes.

      defineNonEnumerableGetter(obj, qn, makeMemoizer(qn, memoizerTarget));

      trampoline.patchTargets = [
        { object: memoizerTarget, name: "value"},
        { object: openMethods,    name: qn },
        { object: obj,            name: VM_OPEN_METHOD_PREFIX + qn }
      ];
    } else if (trait.isGetter() || trait.isSetter()) {
      var trampoline = makeTrampoline(function (self) {
        var fn = runtime.getTraitFunction(trait, scope, natives);
        defineNonEnumerableGetterOrSetter(obj, qn, fn, trait.isGetter());
        return fn;
      });
      defineNonEnumerableGetterOrSetter(obj, qn, trampoline, trait.isGetter());
      // obj[VM_OPEN_METHODS][qn] = trampoline;
      // defineNonEnumerableProperty(obj, VM_OPEN_METHOD_PREFIX + qn, trampoline);
    }
  } else {
    if (trait.isMethod()) {
      var trampoline = makeTrampoline(function (self) {
        var fn = runtime.getTraitFunction(trait, scope, natives);
        defineReadOnlyProperty(obj, qn, fn);
        defineReadOnlyProperty(obj, VM_OPEN_METHOD_PREFIX + qn, fn);
        return fn;
      }, trait.methodInfo.parameters.length);
      var closure = safeBind(trampoline, obj);
      defineReadOnlyProperty(closure, VM_LENGTH, trampoline[VM_LENGTH]);
      defineReadOnlyProperty(closure, Multiname.getPublicQualifiedName("prototype"), null);
      defineNonEnumerableProperty(obj, qn, closure);
      defineNonEnumerableProperty(obj, VM_OPEN_METHOD_PREFIX + qn, closure);
    } else if (trait.isGetter() || trait.isSetter()) {
      var trampoline = makeTrampoline(function (self) {
        var fn = runtime.getTraitFunction(trait, scope, natives);
        defineNonEnumerableGetterOrSetter(obj, qn, fn, trait.isGetter());
        return fn;
      });
      defineNonEnumerableGetterOrSetter(obj, qn, trampoline, trait.isGetter());
    }
  }
}


/**
 * ActionScript Classes are modeled as constructor functions (class objects) which hold additional properties:
 *
 * [scope]: a scope object holding the current class object
 *
 * [baseClass]: a reference to the base class object
 *
 * [instanceTraits]: an accumulated set of traits that are to be applied to instances of this class
 *
 * [prototype]: the prototype object of this constructor function  is populated with the set of instance traits,
 *   when instances are of this class are created, their __proto__ is set to this object thus inheriting this
 *   default set of properties.
 *
 * [construct]: a reference to the class object itself, this is used when invoking the constructor with an already
 *   constructed object (i.e. constructsuper)
 *
 * additionally, the class object also has a set of class traits applied to it which are visible via scope lookups.
 */
function createClass(classInfo, baseClass, scope) {
  assert (!baseClass || baseClass instanceof Class);

  var ci = classInfo;
  var ii = ci.instanceInfo;

  if (ii.isInterface()) {
    return this.createInterface(classInfo);
  }

  var domain = ci.abc.domain;

  var className = Multiname.getName(ii.name);
  if (traceExecution.value) {
    print("Creating class " + className  + (ci.native ? " replaced with native " + ci.native.cls : ""));
  }

  var cls = Class.createClass(classInfo, baseClass, scope);

  if (cls.instanceConstructor) {
    applyProtectedBindings(domain, cls.traitsPrototype, cls);
    applyInterfaceBindings(domain, cls.traitsPrototype, cls);
  }

  // Notify domain of class creation.
  domain.onClassCreated.notify(cls);

  if (cls.instanceConstructor && cls !== Class) {
    cls.verify();
  }

  // TODO: Seal constant traits in the instance object. This should be done after
  // the instance constructor has executed.

  if (traceClasses.value) {
    domain.loadedClasses.push(cls);
    domain.traceLoadedClasses(true);
  }

  if (baseClass && Multiname.getQualifiedName(baseClass.classInfo.instanceInfo.name.name) === "Proxy") {
    // TODO: This is very hackish.
    installProxyClassWrapper(cls);
  }

  // Run the static initializer.
  createFunction(classInfo.init, scope).call(cls);

  // Seal constant traits in the class object.
  compatibility && this.sealConstantTraits(cls, ci.traits);

  return cls;
};

function createInterface(classInfo) {
  var ii = classInfo.instanceInfo;
  release || assert(ii.isInterface());
  if (traceExecution.value) {
    var str = "Creating interface " + ii.name;
    if (ii.interfaces.length) {
      str += " implements " + ii.interfaces.map(function (name) {
        return name.getName();
      }).join(", ");
    }
    print(str);
  }
  return new Interface(classInfo);
}

function applyProtectedBindings(domain, obj, cls) {
  // Deal with the protected namespace bullshit. In AS3, if you have the following code:
  //
  // class A {
  //   protected foo() { ... } // this is actually protected$A$foo
  // }
  //
  // class B extends A {
  //   function bar() {
  //     foo(); // this looks for protected$B$foo, not protected$A$foo
  //   }
  // }
  //
  // You would expect the call to |foo| in the |bar| function to have the protected A
  // namespace open, but it doesn't. So we must create a binding in B's instance
  // prototype from protected$B$foo -> protected$A$foo.
  //
  // If we override foo:
  //
  // class C extends B {
  //   protected override foo() { ... } this is protected$C$foo
  // }
  //
  // Then we need a binding from protected$A$foo -> protected$C$foo, and
  // protected$B$foo -> protected$C$foo.

  var map = createEmptyObject();

  // Walks up the inheritance hierarchy and collects the last defining namespace for each
  // protected member as well as all the protected namespaces from the first definition.
  (function gather(cls) {
    if (cls.baseClass) {
      gather(cls.baseClass);
    }
    var ii = cls.classInfo.instanceInfo;
    for (var i = 0; i < ii.traits.length; i++) {
      var trait = ii.traits[i];
      if (trait.isProtected()) {
        var name = trait.name.getName();
        if (!map[name]) {
          map[name] = {definingNamespace: ii.protectedNs, namespaces: [], trait: trait};
        }
        map[name].definingNamespace = ii.protectedNs;
      }
    }
    for (var name in map) {
      map[name].namespaces.push(ii.protectedNs);
    }
  })(cls);

  var openMethods = obj[VM_OPEN_METHODS];
  var vmBindings = obj[VM_BINDINGS];
  for (var name in map) {
    var definingNamespace = map[name].definingNamespace;
    var protectedQn = Multiname.getQualifiedName(new Multiname([definingNamespace], name));
    var namespaces = map[name].namespaces;
    var trait = map[name].trait;
    for (var i = 0; i < namespaces.length; i++) {
      var qn = Multiname.getQualifiedName(new Multiname([namespaces[i]], name));
      if (qn !== protectedQn) {
        Counter.count("Protected Aliases");
        defineNonEnumerableGetter(obj, qn, makeForwardingGetter(protectedQn));
        defineNonEnumerableSetter(obj, qn, makeForwardingSetter(protectedQn));
        vmBindings.push(qn);
        if (trait.isMethod()) {
          var openMethod = openMethods[protectedQn];
          assert (openMethod);
          defineNonEnumerableProperty(obj, VM_OPEN_METHOD_PREFIX + qn, openMethod);
          openMethods[qn] = openMethod;
        }
      }
    }
  }
}

function applyInterfaceBindings(domain, obj, cls) {
  var implementedInterfaces = cls.implementedInterfaces = createEmptyObject();

  // Apply interface traits recursively.
  //
  // interface IA {
  //   function foo();
  // }
  //
  // interface IB implements IA {
  //   function bar();
  // }
  //
  // class C implements IB {
  //   function foo() { ... }
  //   function bar() { ... }
  // }
  //
  // var a:IA = new C();
  // a.foo(); // callprop IA$foo
  //
  // var b:IB = new C();
  // b.foo(); // callprop IB:foo
  // b.bar(); // callprop IB:bar
  //
  // So, class C must have bindings for:
  //
  // IA$foo -> public$foo
  // IB$foo -> public$foo
  // IB$bar -> public$bar
  //
  // Luckily, interface methods are always public.
  function applyInterfaceTraits(interfaces) {
    for (var i = 0, j = interfaces.length; i < j; i++) {
      var interface = domain.getProperty(interfaces[i], true, true);
      var ii = interface.classInfo.instanceInfo;
      implementedInterfaces[interface.name.qualifiedName] = interface;
      applyInterfaceTraits(ii.interfaces);

      var interfaceTraits = ii.traits;
      for (var k = 0, l = interfaceTraits.length; k < l; k++) {
        var interfaceTrait = interfaceTraits[k];
        var interfaceTraitQn = Multiname.getQualifiedName(interfaceTrait.name);
        var interfaceTraitBindingQn = Multiname.getPublicQualifiedName(Multiname.getName(interfaceTrait.name));
        // TODO: We should just copy over the property descriptor but we can't because it may be a
        // memoizer which will fail to patch the interface trait name. We need to make the memoizer patch
        // all traits bound to it.
        // var interfaceTraitDescriptor = Object.getOwnPropertyDescriptor(bindings, interfaceTraitBindingQn);
        // Object.defineProperty(bindings, interfaceTraitQn, interfaceTraitDescriptor);
        var getter = function (target) {
          return function () {
            return this[target];
          }
        }(interfaceTraitBindingQn);
        Counter.count("Interface Aliases");
        defineNonEnumerableGetter(obj, interfaceTraitQn, getter);
      }
    }
  }
  // Apply traits of all interfaces along the inheritance chain.
  while (cls) {
    applyInterfaceTraits(cls.classInfo.instanceInfo.interfaces);
    cls = cls.baseClass;
  }
}

/**
 * In ActionScript, assigning to a property defined as "const" outside of a static or instance
 * initializer throws a |ReferenceError| exception. To emulate this behaviour in JavaScript,
 * we "seal" constant traits properties by replacing them with setters that throw exceptions.
 */
function sealConstantTraits(obj, traits) {
  var rt = this;
  for (var i = 0, j = traits.length; i < j; i++) {
    var trait = traits[i];
    if (trait.isConst()) {
      var qn = Multiname.getQualifiedName(trait.name);
      var value = obj[qn];
      (function (qn, value) {
        Object.defineProperty(obj, qn, { configurable: false, enumerable: false,
          get: function () {
            return value;
          },
          set: function () {
            rt.throwErrorFromVM("ReferenceError", "Illegal write to read-only property " + qn + ".");
          }
        });
      })(qn, value);
    }
  }
}

function applyType(domain, factory, types) {
  var factoryClassName = factory.classInfo.instanceInfo.name.name;
  if (factoryClassName === "Vector") {
    release || assert(types.length === 1);
    var type = types[0];
    var typeClassName;
    if (type !== null && type !== undefined) {
      typeClassName = type.classInfo.instanceInfo.name.name;
      switch (typeClassName) {
        case "int":
        case "uint":
        case "double":
          break;
        default:
          typeClassName = "object";
          break;
      }
    } else {
      typeClassName = "object";
    }
    return domain.getClass("packageInternal __AS3__.vec.Vector$" + typeClassName);
  } else {
    return notImplemented(factoryClassName);
  }
}

function throwErrorFromVM(domain, errorClass, message, id) {
  throw new (domain.getClass(errorClass)).instanceConstructor(message, id);
}

function translateError(domain, error) {
  if (error instanceof Error) {
    var type = domain.getClass(error.name);
    if (type) {
      return new type.instanceConstructor(translateErrorMessage(error));
    }
    unexpected("Can't translate error: " + error);
  }
  return error;
}

function notifyConstruct(domain, instanceConstructor, args) {
  return domain.vm.notifyConstruct(instanceConstructor, args);
}


/**
 * Memoizers and Trampolines:
 * ==========================
 *
 * In ActionScript 3 the following code creates a method closure for function |m|:
 *
 * class A {
 *   function m() { }
 * }
 *
 * var a = new A();
 * var x = a.m;
 *
 * Here |x| is a method closure for |m| whose |this| pointer is bound to |a|. We want method closures to be
 * created transparently whenever the |m| property is read from |a|. To do this, we install a memoizing
 * getter in the instance prototype that sets the |m| property of the instance object to a bound method closure:
 *
 * Ma = A.instance.prototype.m = function memoizer() {
 *   this.m = m.bind(this);
 * }
 *
 * var a = new A();
 * var x = a.m; // |a.m| calls the memoizer which in turn patches |a.m| to |m.bind(this)|
 * x = a.m; // |a.m| is already a method closure
 *
 * However, this design causes problems for method calls. For instance, we don't want the call expression |a.m()|
 * to be interpreted as |(a.m)()| which creates method closures every time a method is called on a new object.
 * Luckily, method call expressions such as |a.m()| are usually compiled as |callProperty(a, m)| by ASC and
 * lets us determine at compile time whenever a method closure needs to be created. In order to prevent the
 * method closure from being created by the memoizer we install the original |m| in the instance prototype
 * as well, but under a different name |m'|. Whenever we want to avoid creating a method closure, we just
 * access the |m'| property on the object. The expression |a.m()| is compiled by Shumway to |a.m'()|.
 *
 * Memoizers are installed whenever traits are applied which happens when a class is created. At this point
 * we don't actually have the function |m| available, it hasn't been compiled yet. We only want to compile the
 * code that is executed and thus we defer compilation until |m| is actually called. To do this, we create a
 * trampoline that compiles |m| before executing it.
 *
 * Tm = function trampoline() {
 *   return compile(m).apply(this, arguments);
 * }
 *
 * Of course we don't want to recompile |m| every time it is called. We can optimize the trampoline a bit
 * so that it keeps track of repeated executions:
 *
 * Tm = function trampolineContext() {
 *   var c;
 *   return function () {
 *     if (!c) {
 *       c = compile(m);
 *     }
 *     return c.apply(this, arguments);
 *   }
 * }();
 *
 * This is not good enough, we want to prevent repeated executions as much as possible. The way to fix this is
 * to patch the instance prototype to point to the compiled version instead, so that the trampoline doesn't get
 * called again.
 *
 * Tm = function trampolineContext() {
 *   var c;
 *   return function () {
 *     if (!c) {
 *       A.instance.prototype.m = c = compile(m);
 *     }
 *     return c.apply(this, arguments);
 *   }
 * }();
 *
 * This doesn't guarantee that the trampoline won't be called again, an unpatched reference to the trampoline
 * could have leaked somewhere.
 *
 * In fact, the memoizer first has to memoize the trampoline. When the trampoline is executed it needs to patch
 * the memoizer so that the next time around it memoizes |Fm| instead of the trampoline. The trampoline also has
 * to patch |m'| with |Fm|, as well as |m| on the instance with a bound |Fm|.
 *
 * Class inheritance further complicates this picture. Suppose we extend class |A| and call the |m| method on an
 * instance of |B|.
 *
 * class B extends A { }
 *
 * var b = new B();
 * b.m();
 *
 * At first class |A| has a memoizer for |m| and a trampoline for |m'|. If we never call |m| on an instance of |A|
 * then the trampoline is not resolved to a function. When we create class |B| we copy over all the traits in the
 * |A.instance.prototype| to |B.instance.prototype| including the memoizers and trampolines. If we call |m| on an
 * instance of |B| then we're going through a memoizer which will be patched to |Fm| by the trampoline and will
 * be reflected in the entire inheritance hierarchy. The problem is when calling |b.m'()| which currently holds
 * the copied trampoline |Ta| which will patch |A.instance.prototype.m'| and not |m'| in |B|s instance prototype.
 *
 * To solve this we keep track of where trampolines are copied and then patching these locations. We store copy
 * locations in the trampoline function object themselves.
 *
 */
