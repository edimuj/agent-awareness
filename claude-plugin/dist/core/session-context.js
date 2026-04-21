import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
async function git(args, cwd) {
    try {
        const { stdout } = await exec('git', args, {
            cwd,
            timeout: 1500,
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: '0',
            },
        });
        const value = stdout.trim();
        return value.length > 0 ? value : null;
    }
    catch {
        return null;
    }
}
function stripGitSuffix(input) {
    return input.replace(/\.git$/i, '');
}
export function parseGitHubRepoSlug(remoteUrl) {
    const raw = remoteUrl.trim();
    if (!raw)
        return null;
    const scpLike = raw.match(/^git@github\.com:([^/\s]+)\/(.+)$/i);
    if (scpLike) {
        const owner = scpLike[1]?.trim();
        const repo = stripGitSuffix((scpLike[2] ?? '').trim().replace(/\/+$/, ''));
        if (!owner || !repo)
            return null;
        return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    }
    try {
        const url = new URL(raw);
        if (url.hostname.toLowerCase() !== 'github.com')
            return null;
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length < 2)
            return null;
        const owner = parts[0]?.trim();
        const repo = stripGitSuffix((parts[1] ?? '').trim());
        if (!owner || !repo)
            return null;
        return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    }
    catch {
        return null;
    }
}
export async function resolveGatherContext(provider, cwd = process.cwd()) {
    const context = {
        provider,
        cwd,
        sessionRepoSource: 'none',
    };
    const gitRoot = await git(['rev-parse', '--show-toplevel'], cwd);
    if (gitRoot) {
        context.gitRoot = gitRoot;
        context.cwd = cwd;
    }
    const remote = await git(['config', '--get', 'remote.origin.url'], gitRoot ?? cwd);
    const sessionRepo = remote ? parseGitHubRepoSlug(remote) : null;
    if (sessionRepo) {
        context.sessionRepo = sessionRepo;
        context.sessionRepoSource = 'git-remote-origin';
    }
    return context;
}
