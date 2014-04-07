/**
 * Copyright 2013 Mozilla Foundation
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 * http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// Class: Mutex
module Shumway.AVM2.AS.flash.concurrent {
  import notImplemented = Shumway.Debug.notImplemented;
  export class Mutex extends ASNative {
    static initializer: any = null;
    constructor () {
      false && super();
      notImplemented("Dummy Constructor: public flash.concurrent.Mutex");
    }
    // Static   JS -> AS Bindings
    // Static   AS -> JS Bindings
    // Instance JS -> AS Bindings
    // Instance AS -> JS Bindings
    lock(): void {
      notImplemented("public flash.concurrent.Mutex::lock"); return;
    }
    tryLock(): boolean {
      notImplemented("public flash.concurrent.Mutex::tryLock"); return;
    }
    unlock(): void {
      notImplemented("public flash.concurrent.Mutex::unlock"); return;
    }
    ctor(): void {
      notImplemented("public flash.concurrent.Mutex::ctor"); return;
    }
  }
}