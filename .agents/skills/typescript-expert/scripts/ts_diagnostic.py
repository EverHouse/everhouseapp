#!/usr/bin/env python3
"""
TypeScript Project Diagnostic Script
Analyzes TypeScript projects for configuration, performance, and common issues.
"""

import subprocess
import sys
import os
import json
import re
from pathlib import Path

def run_cmd(cmd: list, capture_stderr: bool = False) -> str:
    """Run command with argument list and return output."""
    try:
        if capture_stderr:
            result = subprocess.run(cmd, shell=False, capture_output=True, text=True)
            return result.stdout + result.stderr
        else:
            result = subprocess.run(cmd, shell=False, capture_output=True, text=True, stderr=subprocess.DEVNULL)
            return result.stdout
    except Exception as e:
        return str(e)

def check_versions():
    """Check TypeScript and Node versions."""
    print("\n📦 Versions:")
    print("-" * 40)
    
    ts_version = run_cmd(["npx", "tsc", "--version"]).strip()
    node_version = run_cmd(["node", "-v"]).strip()
    
    print(f"  TypeScript: {ts_version or 'Not found'}")
    print(f"  Node.js: {node_version or 'Not found'}")

def check_tsconfig():
    """Analyze tsconfig.json settings."""
    print("\n⚙️ TSConfig Analysis:")
    print("-" * 40)
    
    tsconfig_path = Path("tsconfig.json")
    if not tsconfig_path.exists():
        print("⚠️ tsconfig.json not found")
        return
    
    try:
        with open(tsconfig_path) as f:
            config = json.load(f)
        
        compiler_opts = config.get("compilerOptions", {})
        
        # Check strict mode
        if compiler_opts.get("strict"):
            print("✅ Strict mode enabled")
        else:
            print("⚠️ Strict mode NOT enabled")
        
        # Check important flags
        flags = {
            "noUncheckedIndexedAccess": "Unchecked index access protection",
            "noImplicitOverride": "Implicit override protection",
            "skipLibCheck": "Skip lib check (performance)",
            "incremental": "Incremental compilation"
        }
        
        for flag, desc in flags.items():
            status = "✅" if compiler_opts.get(flag) else "⚪"
            print(f"  {status} {desc}: {compiler_opts.get(flag, 'not set')}")
        
        # Check module settings
        print(f"\n  Module: {compiler_opts.get('module', 'not set')}")
        print(f"  Module Resolution: {compiler_opts.get('moduleResolution', 'not set')}")
        print(f"  Target: {compiler_opts.get('target', 'not set')}")
        
    except json.JSONDecodeError:
        print("❌ Invalid JSON in tsconfig.json")

def check_tooling():
    """Detect TypeScript tooling ecosystem."""
    print("\n🛠️ Tooling Detection:")
    print("-" * 40)
    
    pkg_path = Path("package.json")
    if not pkg_path.exists():
        print("⚠️ package.json not found")
        return
    
    try:
        with open(pkg_path) as f:
            pkg = json.load(f)
        
        all_deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
        
        tools = {
            "biome": "Biome (linter/formatter)",
            "eslint": "ESLint",
            "prettier": "Prettier",
            "vitest": "Vitest (testing)",
            "jest": "Jest (testing)",
            "turborepo": "Turborepo (monorepo)",
            "turbo": "Turbo (monorepo)",
            "nx": "Nx (monorepo)",
            "lerna": "Lerna (monorepo)"
        }
        
        for tool, desc in tools.items():
            for dep in all_deps:
                if tool in dep.lower():
                    print(f"  ✅ {desc}")
                    break
                    
    except json.JSONDecodeError:
        print("❌ Invalid JSON in package.json")

def check_monorepo():
    """Check for monorepo configuration."""
    print("\n📦 Monorepo Check:")
    print("-" * 40)
    
    indicators = [
        ("pnpm-workspace.yaml", "PNPM Workspace"),
        ("lerna.json", "Lerna"),
        ("nx.json", "Nx"),
        ("turbo.json", "Turborepo")
    ]
    
    found = False
    for file, name in indicators:
        if Path(file).exists():
            print(f"  ✅ {name} detected")
            found = True
    
    if not found:
        print("  ⚪ No monorepo configuration detected")

def check_type_errors():
    """Run quick type check."""
    print("\n🔍 Type Check:")
    print("-" * 40)
    
    result = run_cmd(["npx", "tsc", "--noEmit"], capture_stderr=True)
    # Take first 20 lines
    lines = result.split('\n')[:20]
    result = '\n'.join(lines)
    if "error TS" in result:
        errors = result.count("error TS")
        print(f"  ❌ {errors}+ type errors found")
        print(result[:500])
    else:
        print("  ✅ No type errors")

def check_any_usage():
    """Check for any type usage."""
    print("\n⚠️ 'any' Type Usage:")
    print("-" * 40)
    
    result = run_cmd(["grep", "-r", ": any", "--include=*.ts", "--include=*.tsx", "src/"])
    lines = result.strip().split('\n') if result.strip() else []
    count = len([l for l in lines if l])
    if count > 0:
        print(f"  ⚠️ Found {count} occurrences of ': any'")
        # Show first 5 lines
        sample_lines = lines[:5]
        sample = '\n'.join(sample_lines)
        if sample:
            print(sample)
    else:
        print("  ✅ No explicit 'any' types found")

def check_type_assertions():
    """Check for type assertions."""
    print("\n⚠️ Type Assertions (as):")
    print("-" * 40)
    
    result = run_cmd(["grep", "-r", " as ", "--include=*.ts", "--include=*.tsx", "src/"])
    # Filter out import lines and count
    lines = result.strip().split('\n') if result.strip() else []
    filtered = [l for l in lines if l and 'import' not in l]
    count = len(filtered)
    if count > 0:
        print(f"  ⚠️ Found {count} type assertions")
    else:
        print("  ✅ No type assertions found")

def check_performance():
    """Check type checking performance."""
    print("\n⏱️ Type Check Performance:")
    print("-" * 40)
    
    result = run_cmd(["npx", "tsc", "--extendedDiagnostics", "--noEmit"], capture_stderr=True)
    # Filter for relevant lines
    pattern = re.compile(r'Check time|Files:|Lines:|Nodes:')
    matching_lines = [line for line in result.split('\n') if pattern.search(line)]
    if matching_lines:
        for line in matching_lines:
            print(f"  {line}")
    else:
        print("  ⚠️ Could not measure performance")

def main():
    print("=" * 50)
    print("🔍 TypeScript Project Diagnostic Report")
    print("=" * 50)
    
    check_versions()
    check_tsconfig()
    check_tooling()
    check_monorepo()
    check_any_usage()
    check_type_assertions()
    check_type_errors()
    check_performance()
    
    print("\n" + "=" * 50)
    print("✅ Diagnostic Complete")
    print("=" * 50)

if __name__ == "__main__":
    main()
