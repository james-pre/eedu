import { program } from 'commander';
import $pkg from '../package.json' with { type: 'json' };

program.name('eedu').version($pkg.version).description($pkg.description);

await program.parseAsync();
