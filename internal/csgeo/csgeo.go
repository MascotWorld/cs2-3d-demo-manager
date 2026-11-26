package csgeo

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
)

const (
	MaxGridBytes = 64 * 1024 * 1024
	MaxMeshFloats = 24_000_000 // 8M vertices / ~2.66M triangles
)

var (
	ErrInvalidMagic = errors.New("invalid CSGEO1 magic header")
	ErrInvalidGrid  = errors.New("invalid CSGEO1 grid dimensions or payload size")
	ErrEmptyMesh    = errors.New("empty collision mesh")
)

type Grid struct {
	Shape  [3]int32
	Origin [3]float32
	Step   float32
	bits   []byte
}

type Mesh struct {
	Min       [3]float32
	Max       [3]float32
	TriCount  uint32
	Positions []float32 // 9 floats per triangle (x,y,z * 3) in CS2 world coordinates
	Normals   []int8    // 3 int8 per triangle (nx,ny,nz in {-1,0,1})
}

func LoadFile(path string) (*Grid, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var r io.Reader = f
	if strings.HasSuffix(strings.ToLower(path), ".gz") {
		gz, err := gzip.NewReader(f)
		if err != nil {
			return nil, fmt.Errorf("gzip reader: %w", err)
		}
		defer gz.Close()
		r = gz
	}
	data, err := io.ReadAll(io.LimitReader(r, MaxGridBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > MaxGridBytes {
		return nil, fmt.Errorf("grid exceeds max bytes (%d)", MaxGridBytes)
	}
	return Parse(data)
}

func Parse(data []byte) (*Grid, error) {
	if len(data) < 35 || len(data) > MaxGridBytes {
		return nil, ErrInvalidGrid
	}
	if string(data[:6]) != "CSGEO1" {
		return nil, ErrInvalidMagic
	}
	var shape [3]int32
	var origin [3]float32
	for i := 0; i < 3; i++ {
		shape[i] = int32(binary.LittleEndian.Uint32(data[6+i*4 : 10+i*4]))
		if shape[i] < 1 || shape[i] > 8192 {
			return nil, ErrInvalidGrid
		}
	}
	for i := 0; i < 3; i++ {
		origin[i] = math.Float32frombits(binary.LittleEndian.Uint32(data[18+i*4 : 22+i*4]))
		if math.IsNaN(float64(origin[i])) || math.IsInf(float64(origin[i]), 0) || math.Abs(float64(origin[i])) > 32767 {
			return nil, ErrInvalidGrid
		}
	}
	step := math.Float32frombits(binary.LittleEndian.Uint32(data[30:34]))
	if math.IsNaN(float64(step)) || math.IsInf(float64(step), 0) || step < 2 || step > 64 {
		return nil, ErrInvalidGrid
	}
	totalCells := int64(shape[0]) * int64(shape[1]) * int64(shape[2])
	expectedBytes := 34 + int((totalCells+7)/8)
	if len(data) != expectedBytes {
		return nil, fmt.Errorf("%w: got %d bytes, expected %d", ErrInvalidGrid, len(data), expectedBytes)
	}
	return &Grid{
		Shape:  shape,
		Origin: origin,
		Step:   step,
		bits:   data[34:],
	}, nil
}

func (g *Grid) filled(idx int) bool {
	return (g.bits[idx>>3] & (128 >> (idx & 7))) != 0
}

// GreedyMesh extracts an axis-aligned greedy surface mesh from the CSGEO1 voxel grid.
// Outward face winding matches CS2 right-handed coordinates (+X, +Y, +Z).
func (g *Grid) GreedyMesh() (*Mesh, error) {
	sx := int(g.Shape[1]) * int(g.Shape[2])
	sy := int(g.Shape[2])
	stride := [3]int{sx, sy, 1}

	positions := make([]float32, 0, 1<<18)
	normals := make([]int8, 0, 1<<16)

	minB := [3]float32{math.MaxFloat32, math.MaxFloat32, math.MaxFloat32}
	maxB := [3]float32{-math.MaxFloat32, -math.MaxFloat32, -math.MaxFloat32}

	step := g.Step
	bits := g.bits

	var cell [3]int
	for axis := 0; axis < 3; axis++ {
		a := (axis + 1) % 3
		b := (axis + 2) % 3
		cols := int(g.Shape[a])
		rows := int(g.Shape[b])
		planes := int(g.Shape[axis])
		mask := make([]uint8, cols*rows)

		sa := stride[a]
		sb := stride[b]
		sAxis := stride[axis]

		for side := 0; side <= 1; side++ {
			neighborDelta := -sAxis
			if side == 1 {
				neighborDelta = sAxis
			}
			for plane := 0; plane < planes; plane++ {
				isEdge := (side == 0 && plane == 0) || (side == 1 && plane == planes-1)
				planeOffset := plane * sAxis

				if isEdge {
					for y := 0; y < rows; y++ {
						idx := planeOffset + y*sb
						rowOff := y * cols
						for x := 0; x < cols; x++ {
							if (bits[idx>>3] & (128 >> (idx & 7))) != 0 {
								mask[rowOff+x] = 1
							} else {
								mask[rowOff+x] = 0
							}
							idx += sa
						}
					}
				} else {
					for y := 0; y < rows; y++ {
						idx := planeOffset + y*sb
						rowOff := y * cols
						for x := 0; x < cols; x++ {
							if (bits[idx>>3]&(128>>(idx&7))) != 0 && (bits[(idx+neighborDelta)>>3]&(128>>((idx+neighborDelta)&7))) == 0 {
								mask[rowOff+x] = 1
							} else {
								mask[rowOff+x] = 0
							}
							idx += sa
						}
					}
				}

				for y := 0; y < rows; y++ {
					rowOff := y * cols
					for x := 0; x < cols; x++ {
						idx := rowOff + x
						if mask[idx] == 0 {
							continue
						}
						w := 1
						for x+w < cols && mask[idx+w] != 0 {
							w++
						}
						h := 1
					extend:
						for y+h < rows {
							nextRow := (y+h)*cols + x
							for j := 0; j < w; j++ {
								if mask[nextRow+j] == 0 {
									break extend
								}
							}
							h++
						}
						for j := 0; j < h; j++ {
							clear(mask[(y+j)*cols+x : (y+j)*cols+x+w])
						}

						if len(positions)+18 > MaxMeshFloats {
							return nil, fmt.Errorf("mesh exceeds max float limit (%d)", MaxMeshFloats)
						}

						cell[axis] = plane
						cell[a] = x
						cell[b] = y

						var p0 [3]float32
						p0[0] = g.Origin[0] + float32(cell[0])*step
						p0[1] = g.Origin[1] + float32(cell[1])*step
						p0[2] = g.Origin[2] + float32(cell[2])*step
						p0[axis] += float32(side) * step

						var da, db [3]float32
						da[a] = float32(w) * step
						db[b] = float32(h) * step

						// Quad vertices: v00, v10, v11, v01
						v00 := p0
						v10 := [3]float32{p0[0] + da[0], p0[1] + da[1], p0[2] + da[2]}
						v11 := [3]float32{p0[0] + da[0] + db[0], p0[1] + da[1] + db[1], p0[2] + da[2] + db[2]}
						v01 := [3]float32{p0[0] + db[0], p0[1] + db[1], p0[2] + db[2]}

						// (a x b) points along +axis, so side==1 uses (v00,v10,v11),(v00,v11,v01) and side==0 reverses winding.
						if side == 1 {
							positions = append(positions,
								v00[0], v00[1], v00[2],
								v10[0], v10[1], v10[2],
								v11[0], v11[1], v11[2],
								v00[0], v00[1], v00[2],
								v11[0], v11[1], v11[2],
								v01[0], v01[1], v01[2],
							)
						} else {
							positions = append(positions,
								v00[0], v00[1], v00[2],
								v11[0], v11[1], v11[2],
								v10[0], v10[1], v10[2],
								v00[0], v00[1], v00[2],
								v01[0], v01[1], v01[2],
								v11[0], v11[1], v11[2],
							)
						}

						var n [3]int8
						if side == 1 {
							n[axis] = 1
						} else {
							n[axis] = -1
						}
						normals = append(normals, n[0], n[1], n[2], n[0], n[1], n[2])

						for _, v := range [][3]float32{v00, v11} {
							for k := 0; k < 3; k++ {
								if v[k] < minB[k] {
									minB[k] = v[k]
								}
								if v[k] > maxB[k] {
									maxB[k] = v[k]
								}
							}
						}
					}
				}
			}
		}
	}

	if len(positions) == 0 {
		return nil, ErrEmptyMesh
	}
	triCount := uint32(len(positions) / 9)
	return &Mesh{
		Min:       minB,
		Max:       maxB,
		TriCount:  triCount,
		Positions: positions,
		Normals:   normals,
	}, nil
}

// MarshalBinary encodes a Mesh into CSMSH1 format:
//   "CSMSH1" (6B) + Min [3]float32 (12B) + Max [3]float32 (12B) + TriCount uint32 (4B)
//   + Positions (TriCount*9 float32 LE)
func (m *Mesh) MarshalBinary() []byte {
	headerLen := 34
	buf := make([]byte, headerLen+len(m.Positions)*4)
	copy(buf[:6], "CSMSH1")
	for i := 0; i < 3; i++ {
		binary.LittleEndian.PutUint32(buf[6+i*4:10+i*4], math.Float32bits(m.Min[i]))
		binary.LittleEndian.PutUint32(buf[18+i*4:22+i*4], math.Float32bits(m.Max[i]))
	}
	binary.LittleEndian.PutUint32(buf[30:34], m.TriCount)
	off := headerLen
	for _, f := range m.Positions {
		binary.LittleEndian.PutUint32(buf[off:off+4], math.Float32bits(f))
		off += 4
	}
	return buf
}

func (m *Mesh) MarshalGzip() ([]byte, error) {
	var out bytes.Buffer
	zw, err := gzip.NewWriterLevel(&out, gzip.BestSpeed)
	if err != nil {
		return nil, err
	}
	if _, err := zw.Write(m.MarshalBinary()); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// FindGeoFile searches candidate directories for geo_<map>.bin or geo_<map>.bin.gz.
func FindGeoFile(mapName string, dirs []string) string {
	if mapName == "" || strings.ContainsAny(mapName, `/\..`) {
		return ""
	}
	names := []string{
		fmt.Sprintf("geo_%s.bin", mapName),
		fmt.Sprintf("geo_%s.bin.gz", mapName),
	}
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		for _, name := range names {
			cand := filepath.Join(dir, name)
			if st, err := os.Stat(cand); err == nil && !st.IsDir() {
				return cand
			}
		}
	}
	return ""
}

// ListAvailableMaps scans directories for geo_de_*.bin(.gz) files and returns unique map names.
func ListAvailableMaps(dirs []string) []string {
	seen := make(map[string]bool)
	var out []string
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			name := e.Name()
			if !strings.HasPrefix(name, "geo_") {
				continue
			}
			mapName := strings.TrimPrefix(name, "geo_")
			mapName = strings.TrimSuffix(mapName, ".gz")
			mapName = strings.TrimSuffix(mapName, ".bin")
			if mapName != "" && !seen[mapName] {
				seen[mapName] = true
				out = append(out, mapName)
			}
		}
	}
	return out
}

// FindGlbFile searches candidate directories for <map>.glb or <map>/<map>.glb.
func FindGlbFile(mapName string, dirs []string) string {
	if mapName == "" || strings.ContainsAny(mapName, `/\..`) {
		return ""
	}
	candidates := []string{
		mapName + ".glb",
		filepath.Join(mapName, mapName+".glb"),
	}
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		for _, rel := range candidates {
			cand := filepath.Join(dir, rel)
			if st, err := os.Stat(cand); err == nil && !st.IsDir() {
				return cand
			}
		}
	}
	return ""
}

// ListAvailableGlbs scans directories for <map>.glb files and returns unique map names.
func ListAvailableGlbs(dirs []string) []string {
	seen := make(map[string]bool)
	var out []string
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			name := e.Name()
			if !e.IsDir() && strings.HasSuffix(strings.ToLower(name), ".glb") {
				mapName := strings.TrimSuffix(name, filepath.Ext(name))
				if mapName != "" && !seen[mapName] {
					seen[mapName] = true
					out = append(out, mapName)
				}
			} else if e.IsDir() {
				sub := filepath.Join(dir, name, name+".glb")
				if st, err := os.Stat(sub); err == nil && !st.IsDir() && !seen[name] {
					seen[name] = true
					out = append(out, name)
				}
			}
		}
	}
	return out
}

// FindRadarFile searches candidate directories for <map>_upper.png, <map>_radar.png, or <map>.png.
func FindRadarFile(mapName string, dirs []string) string {
	if mapName == "" || strings.ContainsAny(mapName, `/\..`) {
		return ""
	}
	suffixes := []string{"_upper.png", "_radar.png", ".png", "_upper.webp", "_radar.webp", ".webp", ".jpg"}
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		for _, suf := range suffixes {
			cand := filepath.Join(dir, mapName+suf)
			if st, err := os.Stat(cand); err == nil && !st.IsDir() {
				return cand
			}
		}
	}
	return ""
}

// FindLowerRadarFile searches candidate directories for <map>_lower.png(.webp/.jpg).
func FindLowerRadarFile(mapName string, dirs []string) string {
	if mapName == "" || strings.ContainsAny(mapName, `/\..`) {
		return ""
	}
	suffixes := []string{"_lower.png", "_lower.webp", "_lower.jpg"}
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		for _, suf := range suffixes {
			cand := filepath.Join(dir, mapName+suf)
			if st, err := os.Stat(cand); err == nil && !st.IsDir() {
				return cand
			}
		}
	}
	return ""
}

// RadarOverview holds Valve CS2 overview calibration coordinates for pixel-accurate radar alignment.
type RadarOverview struct {
	PosX     float64  `json:"pos_x"`
	PosY     float64  `json:"pos_y"`
	Scale    float64  `json:"scale"`
	LowerZ   *float64 `json:"lower_z,omitempty"`
}

func float64Ptr(v float64) *float64 { return &v }

// LookupRadarOverview returns standard CS2 overview calibration (1024x1024 reference) when known.
func LookupRadarOverview(mapName string) *RadarOverview {
	table := map[string]RadarOverview{
		"de_nuke":     {PosX: -3453, PosY: 2887, Scale: 7.0, LowerZ: float64Ptr(-495)},
		"de_vertigo":  {PosX: -3168, PosY: 1762, Scale: 4.0, LowerZ: float64Ptr(11700)},
		"de_dust2":    {PosX: -2476, PosY: 3239, Scale: 4.4},
		"de_mirage":   {PosX: -3230, PosY: 1713, Scale: 5.0},
		"de_inferno":  {PosX: -2087, PosY: 3870, Scale: 4.9},
		"de_ancient":  {PosX: -2953, PosY: 2164, Scale: 5.0},
		"de_anubis":   {PosX: -2796, PosY: 3328, Scale: 5.22},
		"de_overpass": {PosX: -4831, PosY: 1781, Scale: 5.2},
		"de_train":    {PosX: -2308, PosY: 2078, Scale: 4.08},
		"de_cache":    {PosX: -2000, PosY: 3250, Scale: 5.5},
	}
	if ov, ok := table[strings.ToLower(mapName)]; ok {
		return &ov
	}
	return nil
}

// RadarContour holds a lightweight 2D top-down silhouette derived from CSGEO1 when no radar image exists.
type RadarContour struct {
	MapName string     `json:"map_name"`
	MinX    float32    `json:"min_x"`
	MinY    float32    `json:"min_y"`
	MaxX    float32    `json:"max_x"`
	MaxY    float32    `json:"max_y"`
	Width   int        `json:"width"`
	Height  int        `json:"height"`
	Cells   []uint8    `json:"cells"` // 0=empty/outside, 1=wall/solid, 2=walkable floor
}

// BuildRadarContour projects the CSGEO1 voxel grid onto a compact <=128x128 2D top-down grid.
func (g *Grid) BuildRadarContour(mapName string) *RadarContour {
	if g == nil || g.Shape[0] <= 0 || g.Shape[1] <= 0 || g.Shape[2] <= 0 {
		return nil
	}
	nx, ny, nz := int(g.Shape[0]), int(g.Shape[1]), int(g.Shape[2])
	step := 1
	maxDim := nx
	if ny > maxDim {
		maxDim = ny
	}
	if maxDim > 128 {
		step = (maxDim + 127) / 128
	}
	w := (nx + step - 1) / step
	h := (ny + step - 1) / step
	cells := make([]uint8, w*h)

	for cy := 0; cy < h; cy++ {
		gy := cy * step
		if gy >= ny {
			gy = ny - 1
		}
		for cx := 0; cx < w; cx++ {
			gx := cx * step
			if gx >= nx {
				gx = nx - 1
			}
			// Walkable cell: solid voxel below and >= 4 open voxels (32+ inches) above it
			var hasFloor, hasSolid bool
			openRun := 0
			wasSolid := false
			baseIdx := gx*ny*nz + gy*nz
			for gz := 0; gz < nz; gz++ {
				if g.filled(baseIdx + gz) {
					hasSolid = true
					wasSolid = true
					openRun = 0
				} else {
					if wasSolid {
						openRun++
						if openRun >= 4 {
							hasFloor = true
						}
					}
				}
			}
			if hasFloor {
				cells[cy*w+cx] = 2
			} else if hasSolid {
				cells[cy*w+cx] = 1
			}
		}
	}

	return &RadarContour{
		MapName: mapName,
		MinX:    g.Origin[0],
		MinY:    g.Origin[1],
		MaxX:    g.Origin[0] + float32(nx)*g.Step,
		MaxY:    g.Origin[1] + float32(ny)*g.Step,
		Width:   w,
		Height:  h,
		Cells:   cells,
	}
}
