import test from 'node:test';
import assert from 'node:assert/strict';
import { antigravityUserDataDir,devToolsPortFile } from '../lib/paths.mjs';

test('debug port paths respect each platform, configuration locations, and explicit overrides',()=>{
  assert.equal(devToolsPortFile({platform:'win32',home:'C:\\Users\\test',env:{}}),'C:\\Users\\test\\AppData\\Roaming\\Antigravity\\DevToolsActivePort');
  assert.equal(devToolsPortFile({platform:'win32',home:'C:\\Users\\test',env:{APPDATA:'E:\\Roaming'}}),'E:\\Roaming\\Antigravity\\DevToolsActivePort');
  assert.equal(devToolsPortFile({platform:'darwin',home:'/Users/test',env:{}}),'/Users/test/Library/Application Support/Antigravity/DevToolsActivePort');
  assert.equal(devToolsPortFile({platform:'linux',home:'/home/test',env:{}}),'/home/test/.config/Antigravity/DevToolsActivePort');
  assert.equal(devToolsPortFile({platform:'linux',home:'/home/test',env:{XDG_CONFIG_HOME:'/opt/config'}}),'/opt/config/Antigravity/DevToolsActivePort');
  assert.equal(antigravityUserDataDir({platform:'linux',env:{ANTIGRAVITY_USER_DATA_DIR:'/custom/profile'}}),'/custom/profile');
  assert.equal(devToolsPortFile({platform:'linux',env:{ANTIGRAVITY_USER_DATA_DIR:'/custom/profile'}}),'/custom/profile/DevToolsActivePort');
  assert.equal(devToolsPortFile({portFile:'explicit',env:{ANTIGRAVITY_CDP_PORT_FILE:'environment'}}),'explicit');
  assert.equal(devToolsPortFile({env:{ANTIGRAVITY_CDP_PORT_FILE:'environment',AGY_BROWSER_ACTIVE_PORT_FILE:'agy-env'}}),'environment');
  assert.equal(devToolsPortFile({env:{AGY_BROWSER_ACTIVE_PORT_FILE:'agy-env'}}),'agy-env');
});
