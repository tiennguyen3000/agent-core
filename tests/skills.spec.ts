import { describe, expect, it } from 'vitest';
import {
  ToolErrorCode,
  ToolRegistry,
  createSkillLoader,
  createSkillTool,
  parseSkillMarkdown,
} from '../src/index.js';
import { makeCtx, memoryFs } from './helpers/ctx.js';

const officeSkill = [
  '---',
  'name: office-docx',
  'description: Create and edit Word documents.',
  '---',
  '',
  '# Word',
  '',
  'Use the bundled Python environment.',
].join('\n');

const plainSkill = ['# Release notes', '', 'Write a short changelog.'].join('\n');

function fsWith(files: Record<string, string>) {
  return memoryFs({ root: '/ws', files });
}

async function loader(files: Record<string, string>, options: Record<string, unknown> = {}) {
  const fs = fsWith(files);
  const subject = createSkillLoader({
    fs,
    sources: [{ root: '/ws/.agents/skills', scope: 'project' }],
    ...options,
  });
  await subject.refresh();
  return { fs, subject };
}

describe('parseSkillMarkdown', () => {
  it('reads name and description from frontmatter', () => {
    const parsed = parseSkillMarkdown(officeSkill);

    expect(parsed.name).toBe('office-docx');
    expect(parsed.description).toBe('Create and edit Word documents.');
    expect(parsed.body).toContain('# Word');
    expect(parsed.body).not.toContain('---');
  });

  it('handles a file without frontmatter', () => {
    const parsed = parseSkillMarkdown(plainSkill);

    expect(parsed.name).toBeUndefined();
    expect(parsed.description).toBeUndefined();
    expect(parsed.body).toBe(plainSkill);
  });

  it('strips quotes and tolerates CRLF', () => {
    const parsed = parseSkillMarkdown('---\r\nname: "quoted"\r\ndescription: \'single\'\r\n---\r\nbody\r\n');

    expect(parsed.name).toBe('quoted');
    expect(parsed.description).toBe('single');
    expect(parsed.body).toBe('body');
  });

  it('treats an unterminated block as plain text', () => {
    const parsed = parseSkillMarkdown('---\nname: broken\n');

    expect(parsed.name).toBeUndefined();
    expect(parsed.body).toBe('---\nname: broken');
  });
});

describe('skill discovery', () => {
  it('finds a directory bundle and a flat file', async () => {
    const { subject } = await loader({
      '.agents/skills/office/SKILL.md': officeSkill,
      '.agents/skills/release.md': plainSkill,
    });

    const entries = subject.catalog();

    expect(entries.map((entry) => entry.name)).toEqual(['office-docx', 'release']);
    expect(entries[0]).toMatchObject({ scope: 'project', bundle: true });
    expect(entries[1]).toMatchObject({ bundle: false, description: 'Release notes' });
  });

  it('keeps the catalog to names and descriptions, not bodies', async () => {
    const { subject } = await loader({ '.agents/skills/office/SKILL.md': officeSkill });

    const section = subject.promptSection();

    expect(section).toContain('office-docx: Create and edit Word documents.');
    expect(section).not.toContain('Use the bundled Python environment.');
  });

  it('bounds the prompt section when there are many skills', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 40; index += 1) {
      files[`.agents/skills/skill-${String(index)}.md`] = `# Skill ${String(index)}\n\nDescription ${String(index)}.`;
    }
    const { subject } = await loader(files, { maxPromptChars: 400 });

    const section = subject.promptSection();

    expect(section).toContain('more skills not shown');
    expect(section.length).toBeLessThan(600);
  });

  it('ignores vendored and hidden-ignore directories', async () => {
    const { subject } = await loader({
      '.agents/skills/node_modules/pkg/SKILL.md': officeSkill,
      '.agents/skills/.git/SKILL.md': officeSkill,
      '.agents/skills/real/SKILL.md': officeSkill,
    });

    expect(subject.catalog().map((entry) => entry.path)).toEqual([
      '/ws/.agents/skills/real/SKILL.md',
    ]);
  });

  it('lets the first source win on a duplicate name', async () => {
    const fs = fsWith({
      'project/dup/SKILL.md': officeSkill,
      'user/dup.md': officeSkill,
    });
    const subject = createSkillLoader({
      fs,
      sources: [
        { root: '/ws/project', scope: 'project' },
        { root: '/ws/user', scope: 'user' },
      ],
    });

    await subject.refresh();
    const entries = subject.catalog();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.scope).toBe('project');
  });

  it('caps the catalog', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 10; index += 1) {
      files[`.agents/skills/s${String(index)}.md`] = `# s${String(index)}`;
    }
    const { subject } = await loader(files, { maxSkills: 3 });

    expect(subject.catalog()).toHaveLength(3);
  });
});

describe('skill loading', () => {
  it('returns the body without frontmatter', async () => {
    const { subject } = await loader({ '.agents/skills/office/SKILL.md': officeSkill });

    const result = await subject.load('office-docx');

    expect(result.ok).toBe(true);
    expect(result.text).toContain('Use the bundled Python environment.');
    expect(result.text).not.toContain('description:');
    expect(result.entry?.path).toBe('/ws/.agents/skills/office/SKILL.md');
  });

  it('matches a name case-insensitively', async () => {
    const { subject } = await loader({ '.agents/skills/office/SKILL.md': officeSkill });

    expect((await subject.load('OFFICE-DOCX')).ok).toBe(true);
  });

  it('lists what is available when the name is unknown', async () => {
    const { subject } = await loader({ '.agents/skills/office/SKILL.md': officeSkill });

    const result = await subject.load('nope');

    expect(result.ok).toBe(false);
    expect(result.code).toBe('E_NOT_FOUND');
    expect(result.text).toContain('office-docx');
  });

  it('truncates a very long body', async () => {
    const { subject } = await loader(
      { '.agents/skills/big/SKILL.md': `# big\n\n${'z'.repeat(500)}` },
      { maxBodyChars: 100 },
    );

    const result = await subject.load('big');

    expect(result.text).toContain('truncated');
    expect(result.text.length).toBeLessThan(300);
  });

  it('scans on demand when load is called before refresh', async () => {
    const fs = fsWith({ '.agents/skills/office/SKILL.md': officeSkill });
    const subject = createSkillLoader({
      fs,
      sources: [{ root: '/ws/.agents/skills', scope: 'project' }],
    });

    expect(subject.catalog()).toEqual([]);
    expect((await subject.load('office-docx')).ok).toBe(true);
  });
});

describe('skill tool', () => {
  it('returns the full instructions', async () => {
    const { subject } = await loader({ '.agents/skills/office/SKILL.md': officeSkill });
    const registry = new ToolRegistry();
    registry.register(createSkillTool({ loader: subject }));

    const result = await registry.dispatch('skill', { name: 'office-docx' }, makeCtx());

    expect(result.ok).toBe(true);
    expect(result.output).toContain('# Word');
    expect(result.meta?.skill).toBe('office-docx');
  });

  it('reports an unknown skill with E_NOT_FOUND', async () => {
    const { subject } = await loader({});
    const registry = new ToolRegistry();
    registry.register(createSkillTool({ loader: subject }));

    const result = await registry.dispatch('skill', { name: 'ghost' }, makeCtx());

    expect(result.code).toBe(ToolErrorCode.NotFound);
    expect(result.output).toContain('Available');
  });
});
