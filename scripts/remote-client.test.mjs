import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const window={};vm.runInNewContext(readFileSync(new URL('../public/remote.js',import.meta.url),'utf8'),{window});
const key=window.HyprlandRemote.keyInput;
test('terminal and Herdr receive equivalent character, control and navigation keys',()=>{
 assert.equal(key('c',{ctrl:true}).data,'\x03');assert.equal(key('c',{ctrl:true}).keys[0],'Ctrl+c');
 assert.equal(key('⏎').data,'\r');assert.equal(key('⏎').keys[0],'Enter');assert.equal(key('⏎').text,'');
 assert.equal(key('⌫').data,'\x7f');assert.equal(key('←').data,'\x1b[D');assert.equal(key('esc').keys[0],'Escape');
 assert.equal(key('h',{shift:true}).text,'H');assert.equal(key('1',{shift:true}).text,'!');
 assert.equal(key('space').text,' ');assert.equal(key('SUPER'),null);
});
