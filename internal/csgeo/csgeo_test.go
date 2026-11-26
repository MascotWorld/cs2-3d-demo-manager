package csgeo

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func makeTestGrid(shape [3]int32, origin [3]float32, step float32, setFn func(x, y, z int32) bool) []byte {
	total := int(shape[0] * shape[1] * shape[2])
	bits := make([]byte, (total+7)/8)
	idx := 0
	for x := int32(0); x < shape[0]; x++ {
		for y := int32(0); y < shape[1]; y++ {
			for z := int32(0); z < shape[2]; z++ {
				if setFn(x, y, z) {
					bits[idx>>3] |= 128 >> (idx & 7)
				}
				idx++
			}
		}
	}
	buf := make([]byte, 34+len(bits))
	copy(buf[:6], "CSGEO1")
	for i := 0; i < 3; i++ {
		binary.LittleEndian.PutUint32(buf[6+i*4:10+i*4], uint32(shape[i]))
		binary.LittleEndian.PutUint32(buf[18+i*4:22+i*4], math.Float32bits(origin[i]))
	}
	binary.LittleEndian.PutUint32(buf[30:34], math.Float32bits(step))
	copy(buf[34:], bits)
	return buf
}

func TestParseAndGreedyMeshSingleBox(t *testing.T) {
	// 2x2x1 solid slab inside a 4x4x4 grid should greedy-merge each of the 6 faces into 1 quad = 12 triangles.
	raw := makeTestGrid([3]int32{4, 4, 4}, [3]float32{-16, -16, 0}, 8, func(x, y, z int32) bool {
		return x >= 1 && x <= 2 && y >= 1 && y <= 2 && z == 1
	})
	g, err := Parse(raw)
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}
	mesh, err := g.GreedyMesh()
	if err != nil {
		t.Fatalf("GreedyMesh failed: %v", err)
	}
	if mesh.TriCount != 12 {
		t.Fatalf("expected 12 triangles for merged 2x2x1 slab, got %d", mesh.TriCount)
	}
	if mesh.Min != [3]float32{-8, -8, 8} || mesh.Max != [3]float32{8, 8, 16} {
		t.Fatalf("unexpected mesh bounds min=%v max=%v", mesh.Min, mesh.Max)
	}

	bin := mesh.MarshalBinary()
	if string(bin[:6]) != "CSMSH1" {
		t.Fatalf("bad mesh magic")
	}
	if len(bin) != 34+int(mesh.TriCount)*9*4 {
		t.Fatalf("unexpected binary size: %d", len(bin))
	}
}

func TestLoadGzipAndListMaps(t *testing.T) {
	tmp := t.TempDir()
	raw := makeTestGrid([3]int32{2, 2, 2}, [3]float32{0, 0, 0}, 8, func(x, y, z int32) bool {
		return x == 0 && y == 0 && z == 0
	})
	gzPath := filepath.Join(tmp, "geo_de_test.bin.gz")
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(raw); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(gzPath, buf.Bytes(), 0644); err != nil {
		t.Fatal(err)
	}
	if found := FindGeoFile("de_test", []string{tmp}); found != gzPath {
		t.Fatalf("FindGeoFile = %q, want %q", found, gzPath)
	}
	maps := ListAvailableMaps([]string{tmp})
	if len(maps) != 1 || maps[0] != "de_test" {
		t.Fatalf("ListAvailableMaps = %v", maps)
	}
	g, err := LoadFile(gzPath)
	if err != nil {
		t.Fatalf("LoadFile gz failed: %v", err)
	}
	m, err := g.GreedyMesh()
	if err != nil {
		t.Fatalf("GreedyMesh failed: %v", err)
	}
	if m.TriCount != 12 {
		t.Fatalf("expected 12 triangles, got %d", m.TriCount)
	}
}

func TestRealGeoCacheAndNukeIfPresent(t *testing.T) {
	geoDirs := os.Getenv("CS2_GEO_DIRS")
	if geoDirs == "" {
		t.Skip("set CS2_GEO_DIRS to enable map-fixture tests")
	}
	dirs := strings.Split(geoDirs, ",")
	for i := range dirs {
		dirs[i] = strings.TrimSpace(dirs[i])
	}
	for _, mapName := range []string{"de_cache", "de_nuke"} {
		p := FindGeoFile(mapName, dirs)
		if p == "" {
			t.Skipf("real geo %s not present on disk", mapName)
		}
		g, err := LoadFile(p)
		if err != nil {
			t.Fatalf("LoadFile(%s): %v", mapName, err)
		}
		m, err := g.GreedyMesh()
		if err != nil {
			t.Fatalf("GreedyMesh(%s): %v", mapName, err)
		}
		t.Logf("%s: shape=%v triangles=%d meshMB=%.2f", mapName, g.Shape, m.TriCount, float64(len(m.Positions)*4)/(1024*1024))
		if m.TriCount < 1000 {
			t.Fatalf("%s unexpectedly small: %d triangles", mapName, m.TriCount)
		}
	}
}
