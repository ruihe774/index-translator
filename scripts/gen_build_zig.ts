// Turns a static CMake configuration (`ninja -t compdb` of its build directory) into a build.zig that links one shared
// library, with only a given set of symbols exported.
// Usage: bun gen_build_zig.ts <config.json> <source dir> <cmake build dir> <output dir>
// The config (scripts/zig/llama.json, audiocpp.json) names the library, its roots and its exports.
//
// The output directory gets build.zig, generated/ (the headers CMake wrote at configure time that the compiles
// include) and overlay/ (the source files the checkout changes from upstream, i.e. our patches applied). Its
// build.zig.zon, with the pinned upstream source and the Vulkan and SPIR-V headers, is kept beside the config as
// <config>.build.zig.zon (written by hand, `zig fetch --save`) and copied; its pin is the one in build_llama.ts or
// build_audiocpp.ts.
//
// Every CMake target becomes a Zig object with its own include paths and flags, as CMake compiled it. What is not
// in the compdb is handled by name (marked GENERATED below): CMake's unity sources and the Vulkan shaders.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

interface Config {
  /** The library's name: lib<name>.so. */
  name: string;
  /** The build.zig.zon dependency with the upstream source. */
  dependency: string;
  /** Ninja outputs whose link closure is the library; absent: every compiled target. */
  roots?: string[];
  /** The library's version script in the source tree, or the globs of the symbols it exports. */
  exports: string | string[];
  /** Our own sources compiled into the library, relative to the output directory, with upstream include dirs. */
  extra?: { dir: string; files: string[]; flags: string[]; includes: string[] };
  /** The Vulkan loader functions ggml-vulkan imports (`nm -D --undefined-only`); the rest come through vkGetInstanceProcAddr. */
  vulkanImports: string[];
}

const [configPath, sourceArg, buildArg, outArg] = Bun.argv.slice(2);
if (!configPath || !sourceArg || !buildArg || !outArg) {
  throw new Error("usage: gen_build_zig.ts <config.json> <source dir> <cmake build dir> <output dir>");
}
const outDir: string = outArg;
const source = sourceArg.replace(/\/$/, "");
const build = buildArg.replace(/\/$/, "");
const config = JSON.parse(readFileSync(configPath, "utf8")) as Config;

interface Entry {
  file: string;
  command: string;
  output: string;
  directory: string;
}
// `
const all = JSON.parse(await Bun.$`ninja -C ${build} -t compdb`.text()) as Entry[];
const entries = all.filter((e) => e.output.endsWith(".o"));
const targetOf = (e: Entry) => /CMakeFiles\/([^/]+)\.dir\//.exec(e.output)![1]!;

const shellSplit = (s: string): string[] =>
  [...s.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => (m[1] ?? m[2]!).replaceAll(/\\(.)/g, "$1"));
/** A compile line as Ninja runs it, without the depfile options it adds (CMake's compile_commands.json has none). */
const compileArgs = (e: Entry) =>
  shellSplit(e.command).filter((a, i, all) => !/^-M[DTF]$/.test(a) && !/^-M[TF]$/.test(all[i - 1] ?? ""));
const inBuild = (p: string) => !relative(build, p).startsWith("..");

/** The CMake targets whose objects make up the roots: the objects on the roots' link lines and the archives they name. */
function closure(roots: string[]): Set<string> {
  const byOutput = new Map(all.map((e) => [e.output, e]));
  const targets = new Set<string>();
  const pending = [...roots];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const output = pending.pop()!;
    if (seen.has(output)) {
      continue;
    }
    seen.add(output);
    const link = byOutput.get(output);
    if (!link) {
      throw new Error(`no command makes ${output}`);
    }
    for (const item of shellSplit(link.command)) {
      if (item.endsWith(".o")) {
        targets.add(/CMakeFiles\/([^/]+)\.dir\//.exec(item)![1]!);
      } else if (item.endsWith(".a") && byOutput.has(item)) {
        pending.push(item);
      }
    }
  }
  return targets;
}
const wanted = config.roots ? closure(config.roots) : new Set(entries.map(targetOf));
const used = entries.filter((e) => wanted.has(targetOf(e)));

/**
 * Flags Zig sets itself, or that are not wanted under Zig. -march and -m<isa> are the target's: Zig puts its own
 * -target-feature after -cflags, so they would be overridden anyway. -g goes with strip.
 */
function keepFlag(flag: string): boolean {
  return (
    !/^-(fPIC|march=.*|O\d|g|std=.*|Wno-maybe-uninitialized|x|m(sse|avx|fma|f16c|bmi).*)$/.test(flag) && flag !== "c++"
  );
}

// The headers CMake generated that the compiles include, found by preprocessing each one (-M -MG: a header that is
// not there yet, like the Vulkan shaders', is listed as it is named).
const deps = new Set<string>();
const extensions = new Set<string>();
await Promise.all(
  Array.from({ length: 16 }, async (_, worker) => {
    for (let i = worker; i < used.length; i += 16) {
      const e = used[i]!;
      if (inBuild(e.file) && !e.file.includes("/Unity/")) {
        continue;
      } // shader sources, made at build time
      const args = compileArgs(e);
      const o = args.indexOf("-o");
      const argv = [...args.slice(0, o), ...args.slice(o + 2)].filter((a) => a !== "-c");
      const proc = Bun.spawn([...argv, "-M", "-MG"], { cwd: e.directory, stdout: "pipe", stderr: "inherit" });
      const text = await new Response(proc.stdout).text();
      if ((await proc.exited) !== 0) {
        throw new Error(`-M failed for ${e.file}`);
      }
      for (const dep of text.replaceAll("\\\n", " ").split(/\s+/).slice(1)) {
        const abs = dep.startsWith("/") ? dep : join(e.directory, dep);
        if (inBuild(abs) && !abs.includes("/Unity/")) {
          deps.add(abs);
        } else if (!relative(source, abs).startsWith("..")) {
          extensions.add(extname(abs));
        }
      }
    }
  }),
);

// The files our patches change: everything that differs from the upstream commit, as it is in the checkout.
const changed = (await Bun.$`git -C ${source} status --porcelain --untracked-files=all`.text())
  .split("\n")
  .filter(Boolean)
  .map((line) => line.slice(3));

rmSync(join(outDir, "generated"), { recursive: true, force: true });
rmSync(join(outDir, "overlay"), { recursive: true, force: true });
for (const dep of deps) {
  if (!(await Bun.file(dep).exists())) {
    continue;
  } // the shader header, made at build time
  const to = join(outDir, "generated", relative(build, dep));
  mkdirSync(dirname(to), { recursive: true });
  cpSync(dep, to);
}
for (const file of changed) {
  mkdirSync(dirname(join(outDir, "overlay", file)), { recursive: true });
  cpSync(join(source, file), join(outDir, "overlay", file));
}

/** A path as Zig code: in the source tree, the shader generator's output or the generated/ copy. */
function lazyPath(abs: string): string {
  const fromSource = relative(source, abs);
  if (!fromSource.startsWith("..")) {
    return `root.path(b, "${fromSource || "."}")`;
  }
  const fromBuild = relative(build, abs);
  if (fromBuild === vulkanBuildDir) {
    return "shaders_hpp.dirname()";
  }
  // A directory none of the compiles takes a header from is still made, so the include path exists.
  mkdirSync(join(outDir, "generated", fromBuild), { recursive: true });
  return `b.path("${join("generated", fromBuild)}")`;
}

interface Group {
  lang: "c" | "cpp";
  std?: string;
  flags: string[];
  files: string[];
}
interface Target {
  includes: string[];
  groups: Map<string, Group>;
}
const targets = new Map<string, Target>();
// GENERATED: the Vulkan shaders are made by commands of their own: one `vulkan-shaders-gen` run writes the header
// (its `file` is the generator's source) and one per shader writes that shader's .cpp (its `file` is the shader).
const shaderEdges = all.filter((e) => e.command.includes("vulkan-shaders-gen") && e.command.includes("--target-cpp"));
const headerEdge = all.find((e) => e.output.endsWith("ggml-vulkan-shaders.hpp") && e.command.includes("--target-hpp"));
const vulkanEntry = headerEdge && used.some((e) => targetOf(e) === "ggml-vulkan") ? headerEdge : undefined;
const vulkanBuildDir = vulkanEntry ? dirname(vulkanEntry.output) : undefined; // Ninja outputs are relative to the build dir

const unknown = new Set<string>();
for (const entry of used) {
  const target = targetOf(entry);
  const args = compileArgs(entry);
  const o = args.indexOf("-o");
  const rest = [...args.slice(1, o), ...args.slice(o + 2)].filter((a, i, all) => a !== "-c" && i !== all.length - 1);
  const includes = rest.filter((a) => a.startsWith("-I")).map((a) => lazyPath(resolve(entry.directory, a.slice(2))));
  const forcedCxx = rest.includes("-x");
  const lang = args[0]!.endsWith("++") && (forcedCxx || !entry.file.endsWith(".c")) ? "cpp" : "c";
  const std = rest.find((a) => a.startsWith("-std="));
  const flags = rest.filter((a) => !a.startsWith("-I") && keepFlag(a));
  for (const f of flags) {
    if (!/^-(D|W|f|w$|pedantic|pedantic-errors$|pthread$)/.test(f)) {
      unknown.add(f);
    }
  }
  // GENERATED: CMake's unity sources only #include the real ones.
  const files = entry.file.includes("/Unity/")
    ? [...readFileSync(entry.file, "utf8").matchAll(/#include "([^"]+)"/g)].map((m) => m[1]!)
    : [entry.file];
  const t = targets.get(target) ?? { includes, groups: new Map<string, Group>() };
  targets.set(target, t);
  // Include paths are per module in Zig, not per file: one target's files must agree on them.
  if (JSON.stringify(t.includes) !== JSON.stringify(includes)) {
    throw new Error(`${target}: include paths differ`);
  }
  const key = JSON.stringify([lang, std, flags, forcedCxx]);
  const g: Group = t.groups.get(key) ?? { lang, std, flags, files: [] };
  t.groups.set(key, g);
  g.files.push(...files);
}
if (unknown.size > 0) {
  throw new Error(`flags with no rule: ${[...unknown].join(" ")}`);
}
for (const t of targets.values()) {
  for (const g of t.groups.values()) {
    for (const f of g.files) {
      extensions.add(extname(f));
    }
  }
}
// GENERATED: the shader generator reads the shaders and the GLSL files they include.
if (vulkanEntry) {
  for (const ext of [".comp", ".glsl"]) {
    extensions.add(ext);
  }
}
if (typeof config.exports === "string") {
  extensions.add(extname(config.exports));
}

const ident = (name: string) => name.replaceAll(/[^A-Za-z0-9]/g, "_");
const zigString = (s: string) => JSON.stringify(s);
const rel = (file: string) => relative(source, file);

const out: string[] = [];
const w = (s = "") => out.push(s);
w(`// Generated by gen_build_zig.ts from a CMake configuration; do not edit.`);
w(`const std = @import("std");`);
w();
w(`pub fn build(b: *std.Build) void {`);
w(
  `    // By default x86-64-v3 (AVX2, FMA, F16C, BMI2: the README's requirement) and Zig's default glibc; -Dtarget and`,
);
w(`    // -Dcpu override it. The sources and defines are still the ones CMake chose for x86-64.`);
w(`    const target = b.standardTargetOptions(.{ .default_target = .{`);
w(`        .cpu_arch = .x86_64,`);
w(`        .os_tag = .linux,`);
w(`        .abi = .gnu,`);
w(`        .cpu_model = .{ .explicit = &std.Target.x86.cpu.x86_64_v3 },`);
w(`    } });`);
w(`    const optimize: std.builtin.OptimizeMode = .ReleaseFast;`);
w(`    const upstream = b.dependency("${config.dependency}", .{});`);
if (changed.length === 0) {
  w(`    const root = upstream.path(".");`);
} else {
  w(`    // Upstream with our patches applied: the files they change are in overlay/.`);
  w(`    const root = blk: {`);
  w(`        const tree = b.addWriteFiles();`);
  w(`        _ = tree.addCopyDirectory(upstream.path("."), "", .{`);
  w(`            .include_extensions = &.{ ${[...extensions].sort().map(zigString).join(", ")} },`);
  w(`        });`);
  // A directory, not addCopyFile: the step copies files before directories, and in the order they were added.
  w(`        _ = tree.addCopyDirectory(b.path("overlay"), "", .{});`);
  w(`        break :blk tree.getDirectory();`);
  w(`    };`);
}
w(`    // The headers CMake found in the system include directory, which the compdb does not show.`);
w(`    const vulkan_headers = b.dependency("vulkan_headers", .{});`);
w(`    const spirv_headers = b.dependency("spirv_headers", .{});`);
w();

// GENERATED: the Vulkan shaders. The generator is a host tool (CMake's ExternalProject), built with the
// GLSLC_SUPPORT defines ggml-vulkan was given; it calls glslc, which stays a host tool.
const vulkanGroups = [...(targets.get("ggml-vulkan")?.groups.values() ?? [])];
const glslcDefines = [...new Set(vulkanGroups.flatMap((g) => g.flags.filter((f) => f.endsWith("GLSLC_SUPPORT"))))];
const shaders = shaderEdges.map((e) => basename(e.file));
if (vulkanEntry && shaders.length > 0) {
  const shaderDir = rel(dirname(vulkanEntry.file));
  w(`    const shaders_gen = b.addExecutable(.{`);
  w(`        .name = "vulkan-shaders-gen",`);
  w(
    `        .root_module = b.createModule(.{ .target = b.graph.host, .optimize = .ReleaseSafe, .link_libcpp = true }),`,
  );
  w(`    });`);
  w(`    shaders_gen.root_module.addCSourceFiles(.{`);
  w(`        .root = root.path(b, "${shaderDir}"),`);
  w(`        .files = &.{"${basename(vulkanEntry.file)}"},`);
  w(`        .flags = &.{ "-std=c++17", ${glslcDefines.map(zigString).join(", ")} },`);
  w(`    });`);
  w(`    const shaders_hpp = blk: {`);
  w(`        const run = b.addRunArtifact(shaders_gen);`);
  w(`        run.addArg("--output-dir");`);
  w(`        _ = run.addOutputDirectoryArg("spv");`);
  w(`        run.addArg("--target-hpp");`);
  w(`        break :blk run.addOutputFileArg("ggml-vulkan-shaders.hpp");`);
  w(`    };`);
  w(`    const shader_names = [_][]const u8{ ${shaders.map(zigString).join(", ")} };`);
  w(`    var shader_cpps: [shader_names.len]std.Build.LazyPath = undefined;`);
  w(`    for (shader_names, &shader_cpps) |name, *cpp| {`);
  w(`        const run = b.addRunArtifact(shaders_gen);`);
  w(`        run.addArgs(&.{ "--glslc", "glslc", "--source" });`);
  w(`        run.addFileArg(root.path(b, b.fmt("${shaderDir}/{s}", .{name})));`);
  w(`        run.addArg("--output-dir");`);
  w(`        _ = run.addOutputDirectoryArg("spv");`);
  w(`        run.addArgs(&.{ "--target-hpp", "ggml-vulkan-shaders.hpp", "--target-cpp" });`);
  w(`        cpp.* = run.addOutputFileArg(b.fmt("{s}.cpp", .{name}));`);
  w(`    }`);
  w();
  // GENERATED: a stub with the loader's soname is all the link needs; the system's libvulkan.so.1 is used at run time.
  w(`    const vulkan_stub = b.addLibrary(.{`);
  w(`        .name = "vulkan",`);
  w(`        .linkage = .dynamic,`);
  w(`        .version = .{ .major = 1, .minor = 0, .patch = 0 },`);
  w(`        .root_module = b.createModule(.{ .target = target, .optimize = optimize, .link_libc = true }),`);
  w(`    });`);
  w(`    vulkan_stub.root_module.addCSourceFile(.{ .file = b.addWriteFiles().add("vulkan-stub.c",`);
  for (const fn of config.vulkanImports) {
    w(`        \\\\void ${fn}(void) {}`);
  }
  w(`    ) });`);
  w();
}

// The one library. Only the exported API is visible, so ggml and libc++ stay private to it.
w(`    const lib = b.addLibrary(.{`);
w(`        .name = "${config.name}",`);
w(`        .linkage = .dynamic,`);
w(`        .root_module = b.createModule(.{`);
w(`            .target = target,`);
w(`            .optimize = optimize,`);
w(`            .pic = true,`);
w(`            .strip = true,`);
w(`            .link_libc = true,`);
w(`            .link_libcpp = true,`);
w(`        }),`);
w(`    });`);
if (config.extra) {
  w(`    lib.root_module.addCSourceFiles(.{`);
  w(`        .root = b.path("${config.extra.dir}"),`);
  w(`        .files = &.{ ${config.extra.files.map(zigString).join(", ")} },`);
  w(`        .flags = &.{ ${config.extra.flags.map(zigString).join(", ")} },`);
  w(`    });`);
  for (const dir of config.extra.includes) {
    w(`    lib.root_module.addIncludePath(root.path(b, "${dir}"));`);
  }
}
if (typeof config.exports === "string") {
  w(`    lib.setVersionScript(root.path(b, "${config.exports}"));`);
} else {
  w(`    lib.setVersionScript(b.addWriteFiles().add("exports.map",`);
  w(`        \\\\{ global: ${config.exports.map((e) => `${e};`).join(" ")} local: *; };`);
  w(`    ));`);
}
if (vulkanEntry) {
  w(`    lib.root_module.addObjectFile(vulkan_stub.getEmittedBin());`);
}
w(`    b.installArtifact(lib);`);
w();

for (const [name, t] of targets) {
  const v = ident(name);
  w(`    const ${v} = b.addObject(.{`);
  w(`        .name = "${name}",`);
  w(`        .root_module = b.createModule(.{`);
  w(`            .target = target,`);
  w(`            .optimize = optimize,`);
  w(`            .pic = true,`);
  w(`            .strip = true,`);
  w(`            .link_libc = true,`);
  if ([...t.groups.values()].some((g) => g.lang === "cpp")) {
    w(`            .link_libcpp = true,`);
  }
  w(`        }),`);
  w(`    });`);
  for (const g of t.groups.values()) {
    const inSource = g.files.filter((f) => !inBuild(f));
    const generated = g.files.length - inSource.length;
    const flags = [...(g.std ? [g.std] : []), ...g.flags].map(zigString).join(", ");
    w(`    {`);
    w(`        const flags: []const []const u8 = &.{ ${flags} };`);
    if (inSource.length > 0) {
      w(`        ${v}.root_module.addCSourceFiles(.{`);
      w(`            .root = root,`);
      w(`            .language = .${g.lang},`);
      w(`            .flags = flags,`);
      w(`            .files = &.{`);
      for (const f of inSource) {
        w(`                "${rel(f)}",`);
      }
      w(`            },`);
      w(`        });`);
    }
    if (generated > 0) {
      w(
        `        for (shader_cpps) |cpp| ${v}.root_module.addCSourceFile(.{ .file = cpp, .language = .cpp, .flags = flags });`,
      );
    }
    w(`    }`);
  }
  for (const inc of t.includes) {
    w(`    ${v}.root_module.addIncludePath(${inc});`);
  }
  if (name === "ggml-vulkan") {
    w(`    ${v}.root_module.addIncludePath(vulkan_headers.path("include"));`);
    w(`    ${v}.root_module.addIncludePath(spirv_headers.path("include"));`);
  }
  w(`    lib.root_module.addObject(${v});`);
  w();
}
w(`}`);
cpSync(configPath.replace(/\.json$/, ".build.zig.zon"), join(outDir, "build.zig.zon"));
writeFileSync(join(outDir, "build.zig"), `${out.join("\n")}\n`);
console.log(
  `${outDir}/build.zig: ${targets.size} targets, ${used.length} compiles, ${deps.size} generated headers, ${changed.length} patched files`,
);
