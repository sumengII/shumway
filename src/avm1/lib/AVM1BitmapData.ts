/**
 * Copyright 2014 Mozilla Foundation
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

///<reference path='../references.ts' />

module Shumway.AVM1.Lib {
  import flash = Shumway.AVMX.AS.flash;

  export class AVM1BitmapData extends AVM1Proxy<flash.display.BitmapData> {
    static createAVM1Class(context: AVM1Context): AVM1Object {
      return AVM1Proxy.wrap<AVM1BitmapData>(context, AVM1BitmapData, ['loadBitmap'], []);
    }

    public avm1Constructor() {
      var as3Object = new this.context.securityDomain.flash.display.BitmapData(); // REDUX parameters
      this.setTarget(as3Object);
    }

    static loadBitmap(context: AVM1Context, symbolId: string): AVM1BitmapData {
      symbolId = alCoerceString(context, symbolId);
      var symbol = context.getAsset(symbolId);
      if (symbol && symbol.symbolProps instanceof flash.display.BitmapSymbol) {
        // REDUX
        var bitmap = undefined; /// (<any>AVM1BitmapData).initializeFrom(symbol);
        // bitmap.class.instanceConstructorNoInitialize.call(bitmap);
        return bitmap;
      }
      return null;
    }
  }
}