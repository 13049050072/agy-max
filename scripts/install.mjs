import { accessSync, constants as fsConstants } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPlugin,parseLifecycleArgs,planLifecycle } from '../lib/lifecycle.mjs';
import { isWslEnvironment } from '../lib/wsl.mjs';
const hasStandardPosixNode=()=>['/usr/local/bin/node','/usr/bin/node','/bin/node'].some(p=>{try{accessSync(p,fsConstants.X_OK);return true;}catch{return false;}});
const [major,minor]=process.versions.node.split('.').map(Number);
try{
  if(major<22||major===22&&minor<13)throw Error('需要 Node.js 22.13 或更高版本');
  const args=parseLifecycleArgs(process.argv.slice(2));
  if(args.help)console.log('Usage: install [--home <directory>] [--skip-agy-fast] [--dry-run] [--json] [--help]');
  else{
    const options={source:resolve(dirname(fileURLToPath(import.meta.url)),'..'),home:args.home,skipAgyFast:args['skip-agy-fast']};
    const result=args['dry-run']?planLifecycle(options):await installPlugin(options);
    if(args.json)console.log(JSON.stringify(result));
    else if(result.dryRun)console.log(JSON.stringify(result,null,2));
    else{
    console.log(`已安装 Antigravity Max ${result.version}`);
    if(result.migratedLegacy)console.log('已自动停用旧版 agy-powertools 并无损继承原有设置与账号配置。');
    console.log('请重新打开 Antigravity，安装过程中没有关闭客户端。');
    if(process.platform==='darwin'&&result.macLauncherApp){
      console.log(`macOS 提示：已生成启动器 ${result.macLauncherApp}${result.macLauncherIconConfigured?'（已自动配置原版图标）':''}。`);
      console.log('建议将其拖入 Dock 栏替换原 Antigravity 图标，以后直接从 Dock 启动即可自动启用插件。');
    }
    if(isWslEnvironment()&&!/^\/(?:usr\/local\/bin|usr\/bin|bin)\//.test(process.execPath)&&!hasStandardPosixNode()){
      console.log(`WSL2 提示：当前 Node.js 位于 ${process.execPath}。由于 Antigravity 通过非登录 Shell 启动 WSL2 后端，若插件未加载，建议执行：sudo ln -sf "${process.execPath}" /usr/local/bin/node`);
    }
    }
  }
}catch(error){console.error('安装失败：'+error.message);process.exitCode=1;}
