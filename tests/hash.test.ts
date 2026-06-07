import { describe, it, expect } from "vitest";
import { normalizeOutputForHashing, hashContent } from "../src/hash.js";

describe("hash.ts", () => {
  describe("normalizeOutputForHashing", () => {
    it("strips standard time formats", () => {
      const output = "Operation completed in 1.23s and 45ms and 1m";
      expect(normalizeOutputForHashing(output)).toBe("Operation completed in  and  and");
    });

    it("strips absolute temp directory paths", () => {
      const output = "Writing to /tmp/aBcD123_45/file.txt and /tmp/xyz/other.txt";
      expect(normalizeOutputForHashing(output)).toBe("Writing to /tmp/xxx/file.txt and /tmp/xxx/other.txt");
    });

    it("strips memory addresses", () => {
      const output = "Object at 0x7ffee1b2c3d4 or 0x123ABC";
      expect(normalizeOutputForHashing(output)).toBe("Object at 0xXXX or 0xXXX");
    });

    it("strips incrementing filenames", () => {
      const output = "Compiling file1.c and test_runner23.ts and check3.txt";
      expect(normalizeOutputForHashing(output)).toBe("Compiling file.c and test_runner.ts and check.txt");
    });

    it("strips line and column numbers (file.c:170:3:)", () => {
      const output = "file.c:170:3: warning: unused variable";
      expect(normalizeOutputForHashing(output)).toBe("file.c:LINE:COL: warning: unused variable");
    });

    it("strips single line locations (file.c:19:)", () => {
      const output = "file.c:19: error: missing semicolon";
      expect(normalizeOutputForHashing(output)).toBe("file.c:LINE: error: missing semicolon");
    });

    it("strips compiler gutter line numbers", () => {
      const output = `  170 |   fread(a.dat, tmp, 1, fp);
      |   ^~~~~~~~~~~~~~~~~~~~~~~~
  172 |   something();`;
      const expected = `  LINE |   fread(a.dat, tmp, 1, fp);
      |   ^~~~~~~~~~~~~~~~~~~~~~~~
  LINE |   something();`.trim();
      expect(normalizeOutputForHashing(output)).toBe(expected);
    });

    it("normalizes realistic gcc compiler warnings correctly (Identical Outputs)", () => {
      const out1 = `gpt2_full_patched5.c: In function 'read_matrix':
gpt2_full_patched5.c:170:3: warning: ignoring return value of 'fread' declared with attribute 'warn_unused_result' [-Wunused-result]
  170 |   fread(a.dat, tmp, 1, fp);
      |   ^~~~~~~~~~~~~~~~~~~~~~~~
In file included from /usr/include/string.h:548,
                 from gpt2_full_patched5.c:19:
/usr/include/x86_64-linux-gnu/bits/string_fortified.h:59:10: warning: '__builtin_memset' specified size
  342 | void *memory, *memory_top;`;

      const out2 = `gpt2_full_patched6.c: In function 'read_matrix':
gpt2_full_patched6.c:172:3: warning: ignoring return value of 'fread' declared with attribute 'warn_unused_result' [-Wunused-result]
  172 |   fread(a.dat, tmp, 1, fp);
      |   ^~~~~~~~~~~~~~~~~~~~~~~~
In file included from /usr/include/string.h:548,
                 from gpt2_full_patched6.c:19:
/usr/include/x86_64-linux-gnu/bits/string_fortified.h:59:10: warning: '__builtin_memset' specified size
  344 | void *memory, *memory_top;`;

      const norm1 = normalizeOutputForHashing(out1);
      const norm2 = normalizeOutputForHashing(out2);
      expect(norm1).toBe(norm2);
    });
  });

  describe("hashContent", () => {
    it("produces identical hashes for identical inputs", () => {
      expect(hashContent("hello")).toBe(hashContent("hello"));
    });

    it("produces different hashes for different inputs", () => {
      expect(hashContent("hello")).not.toBe(hashContent("world"));
    });
  });
});