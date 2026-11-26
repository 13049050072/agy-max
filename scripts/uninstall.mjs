import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { uninstallPlugin,parseLifecycleArgs,planLifecycle } from '../lib/lifecycle.mjs';
try{
  const originalCwd=process.cwd(),args=parseLifecycleArgs(process.argv.slice(2),{uninstall:true});
  if(args.help)console.log('Usage: uninstall [--home <directory>] [--keep-settings] [--skip-agy-fast] [--dry-run] [--json] [--help]');
  else{
    const options={home:args.home===undefined?undefined:resolve(originalCwd,args.home),purge:!args['keep-settings'],skipAgyFast:args['skip-agy-fast']};
    let result;
    if(args['dry-run'])result=planLifecycle({...options,uninstall:true});
    else{process.chdir(tmpdir());result=await uninstallPlugin(options);}
    if(args.json)console.log(JSON.stringify(result));
    else if(result.dryRun)console.log(JSON.stringify(result,null,2));
    else{console.log(result.purged?'已卸载并清理插件数据，原生聊天记录已保留。':'已卸载，个人设置已保留。');if(result.retained.length)console.log(`保留了 ${result.retained.length} 项文件或目录。`);}
  }
}catch(error){console.error('卸载失败：'+error.message);process.exitCode=1;}
