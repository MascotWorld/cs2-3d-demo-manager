package server

import (
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"cs2-3d-demo-manager/internal/csgeo"
	"cs2-3d-demo-manager/internal/parser"
	"cs2-3d-demo-manager/internal/store"
)

const (
	MaxUploadDemoBytes  = 512 * 1024 * 1024
	MaxUploadAssetBytes = 256 * 1024 * 1024
)

var validNameRe = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

type Config struct {
	Store     *store.Store
	GeoDirs   []string
	AssetDirs []string
	StaticDir string
}

type Server struct {
	cfg    Config
	mux    *http.ServeMux
	geoMu  sync.Mutex
}

func New(cfg Config) *Server {
	s := &Server{
		cfg: cfg,
		mux: http.NewServeMux(),
	}
	s.routes()
	return s
}

func (s *Server) Handler() http.Handler {
	return s.mux
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /api/health", s.handleHealth)
	s.mux.HandleFunc("GET /api/demos", s.handleListDemos)
	s.mux.HandleFunc("POST /api/demos/upload", s.handleUploadDemo)
	s.mux.HandleFunc("POST /api/demos/register", s.handleRegisterDemo)
	s.mux.HandleFunc("GET /api/demos/{id}", s.handleGetDemo)
	s.mux.HandleFunc("POST /api/demos/{id}/reparse", s.handleReparseDemo)
	s.mux.HandleFunc("DELETE /api/demos/{id}", s.handleDeleteDemo)
	s.mux.HandleFunc("GET /api/demos/{id}/rounds/{round}", s.handleGetRound)
	s.mux.HandleFunc("GET /api/demos/{id}/bookmarks", s.handleListBookmarks)
	s.mux.HandleFunc("POST /api/demos/{id}/bookmarks", s.handleCreateBookmark)
	s.mux.HandleFunc("DELETE /api/demos/{id}/bookmarks/{bookmarkId}", s.handleDeleteBookmark)

	s.mux.HandleFunc("GET /api/maps/{mapName}/mesh", s.handleGetMapMesh)
	s.mux.HandleFunc("GET /api/maps/{mapName}/radar", s.handleGetMapRadar)
	s.mux.HandleFunc("GET /api/assets/dirs", s.handleListAssetDirs)
	s.mux.HandleFunc("POST /api/assets/dirs", s.handleAddAssetDir)
	s.mux.HandleFunc("DELETE /api/assets/dirs", s.handleDeleteAssetDir)
	s.mux.HandleFunc("POST /api/assets/maps/{mapName}", s.handleUploadMapAsset)
	s.mux.HandleFunc("GET /api/assets/maps/{mapName}", s.handleGetMapAsset)
	s.mux.HandleFunc("DELETE /api/assets/maps/{mapName}", s.handleDeleteMapAsset)
	s.mux.HandleFunc("GET /api/assets/radars/{mapName}", s.handleGetRadarAsset)

	s.mux.HandleFunc("POST /api/assets/player", s.handleUploadPlayerAsset)
	s.mux.HandleFunc("GET /api/assets/player", s.handleGetPlayerAsset)
	s.mux.HandleFunc("DELETE /api/assets/player", s.handleDeletePlayerAsset)
	s.mux.HandleFunc("GET /api/assets/players/{role}", s.handleGetRolePlayerAsset)
	s.mux.HandleFunc("GET /api/assets/weapons/{weaponName}", s.handleGetWeaponAsset)
	s.mux.HandleFunc("GET /api/assets/skyboxes/{skyName}", s.handleGetSkyboxAsset)
	s.mux.HandleFunc("GET /api/assets/hud/{group}/{filename}", s.handleGetHUDAsset)

	if s.cfg.StaticDir != "" {
		s.mux.HandleFunc("/", s.handleStatic)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func newID(prefix string) string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return prefix + "_" + hex.EncodeToString(b[:])
}

func (s *Server) allAssetDirs() []string {
	seen := make(map[string]bool)
	var out []string
	add := func(d string) {
		if d == "" {
			return
		}
		clean := filepath.Clean(d)
		if !seen[clean] {
			seen[clean] = true
			out = append(out, clean)
		}
	}
	for _, d := range s.cfg.GeoDirs {
		add(d)
	}
	for _, d := range s.cfg.AssetDirs {
		add(d)
	}
	if s.cfg.Store != nil {
		add(filepath.Join(s.cfg.Store.DataDir(), "assets", "radars"))
		add(filepath.Join(s.cfg.Store.DataDir(), "assets", "maps"))
	}
	for _, d := range s.cfg.AssetDirs {
		if d != "" {
			add(filepath.Join(d, "radars"))
			add(filepath.Join(d, "maps"))
		}
	}
	if saved, err := s.cfg.Store.ListAssetDirs(); err == nil {
		for _, d := range saved {
			add(d)
		}
	}
	return out
}

func (s *Server) listCustomMaps() []string {
	seen := make(map[string]bool)
	var out []string
	add := func(name string) {
		if name != "" && !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	dir := filepath.Join(s.cfg.Store.DataDir(), "assets", "maps")
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".glb") {
				add(strings.TrimSuffix(e.Name(), ".glb"))
			}
		}
	}
	for _, m := range csgeo.ListAvailableGlbs(s.allAssetDirs()) {
		add(m)
	}
	return out
}

func (s *Server) listGlbStems(subdir string) []string {
	seen := make(map[string]bool)
	out := []string{}
	var dirs []string
	if s.cfg.Store != nil {
		dirs = append(dirs, filepath.Join(s.cfg.Store.DataDir(), "assets", subdir))
	}
	for _, d := range s.allAssetDirs() {
		dirs = append(dirs, filepath.Join(d, subdir))
	}
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(strings.ToLower(e.Name()), ".glb") {
				stem := strings.TrimSuffix(e.Name(), ".glb")
				if stem == "operator_anims" {
					continue
				}
				if stem != "" && !seen[stem] {
					seen[stem] = true
					out = append(out, stem)
				}
			}
		}
	}
	sort.Strings(out)
	return out
}

func (s *Server) findRoleOrWeaponGlb(subdir, name string) string {
	if s.cfg.Store != nil {
		p := filepath.Join(s.cfg.Store.DataDir(), "assets", subdir, name+".glb")
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	for _, d := range s.allAssetDirs() {
		p := filepath.Join(d, subdir, name+".glb")
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

func (s *Server) hasCustomPlayer() bool {
	p := filepath.Join(s.cfg.Store.DataDir(), "assets", "players", "custom_player.glb")
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func (s *Server) listSkyboxes() []string {
	seen := make(map[string]bool)
	out := []string{}
	var dirs []string
	if s.cfg.Store != nil {
		dirs = append(dirs, filepath.Join(s.cfg.Store.DataDir(), "assets", "skyboxes"))
	}
	for _, d := range s.allAssetDirs() {
		dirs = append(dirs, filepath.Join(d, "skyboxes"))
	}
	exts := []string{".webp", ".png", ".jpg", ".jpeg"}
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			lower := strings.ToLower(e.Name())
			for _, ext := range exts {
				if strings.HasSuffix(lower, ext) {
					stem := e.Name()[:len(e.Name())-len(ext)]
					if stem != "" && !seen[stem] {
						seen[stem] = true
						out = append(out, stem)
					}
					break
				}
			}
		}
	}
	sort.Strings(out)
	return out
}

func (s *Server) findSkyboxAsset(name string) (string, string) {
	var dirs []string
	if s.cfg.Store != nil {
		dirs = append(dirs, filepath.Join(s.cfg.Store.DataDir(), "assets", "skyboxes"))
	}
	for _, d := range s.allAssetDirs() {
		dirs = append(dirs, filepath.Join(d, "skyboxes"))
	}
	exts := []struct {
		ext  string
		mime string
	}{
		{".webp", "image/webp"},
		{".png", "image/png"},
		{".jpg", "image/jpeg"},
		{".jpeg", "image/jpeg"},
	}
	for _, dir := range dirs {
		for _, item := range exts {
			p := filepath.Join(dir, name+item.ext)
			if st, err := os.Stat(p); err == nil && !st.IsDir() {
				return p, item.mime
			}
		}
	}
	return "", ""
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	dirs := s.allAssetDirs()
	savedDirs, _ := s.cfg.Store.ListAssetDirs()
	if savedDirs == nil {
		savedDirs = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":                 true,
		"geo_maps":           csgeo.ListAvailableMaps(dirs),
		"custom_maps":        s.listCustomMaps(),
		"asset_dirs":         savedDirs,
		"has_custom_player":  s.hasCustomPlayer(),
		"has_operator_anims": s.findRoleOrWeaponGlb("players", "operator_anims") != "",
		"player_models":      s.listGlbStems("players"),
		"weapon_models":      s.listGlbStems("weapons"),
		"skyboxes":           s.listSkyboxes(),
		"hud_assets":         s.listHUDAssets(),
	})
}

func (s *Server) handleListDemos(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	m := r.URL.Query().Get("map")
	items, err := s.cfg.Store.ListDemos(q, m)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if items == nil {
		items = []store.DemoListItem{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"demos": items})
}

func (s *Server) handleUploadDemo(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, MaxUploadDemoBytes)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeErr(w, http.StatusBadRequest, fmt.Sprintf("invalid upload form: %v", err))
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "missing multipart field 'file'")
		return
	}
	defer file.Close()

	base := filepath.Base(header.Filename)
	lower := strings.ToLower(base)
	ext := ""
	switch {
	case strings.HasSuffix(lower, ".dem.bz2"):
		ext = ".dem.bz2"
	case strings.HasSuffix(lower, ".dem"):
		ext = ".dem"
	default:
		writeErr(w, http.StatusBadRequest, "only .dem and .dem.bz2 files are supported")
		return
	}

	id := newID("demo")
	safeBase := strings.Map(func(c rune) rune {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_' {
			return c
		}
		return '_'
	}, base)
	destPath := filepath.Join(s.cfg.Store.DataDir(), "demos", id+"_"+safeBase)
	if !strings.HasSuffix(strings.ToLower(destPath), ext) {
		destPath += ext
	}

	dst, err := os.Create(destPath)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if _, err := io.Copy(dst, file); err != nil {
		dst.Close()
		_ = os.Remove(destPath)
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	dst.Close()

	match, err := parser.ParseDemo(id, destPath)
	if err != nil {
		_ = os.Remove(destPath)
		writeErr(w, http.StatusBadRequest, fmt.Sprintf("failed to parse demo: %v", err))
		return
	}
	match.Metadata.Filename = base
	if err := s.cfg.Store.SaveMatch(match, true); err != nil {
		_ = os.Remove(destPath)
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"demo": match.Metadata})
}

func (s *Server) handleRegisterDemo(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path    string `json:"path"`
		Reparse bool   `json:"reparse"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	path := strings.TrimSpace(req.Path)
	if path == "" {
		writeErr(w, http.StatusBadRequest, "path is required")
		return
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid path")
		return
	}
	st, err := os.Stat(absPath)
	if err != nil || st.IsDir() {
		writeErr(w, http.StatusBadRequest, "demo file not found on disk")
		return
	}
	lower := strings.ToLower(absPath)
	if !strings.HasSuffix(lower, ".dem") && !strings.HasSuffix(lower, ".dem.bz2") {
		writeErr(w, http.StatusBadRequest, "file must end in .dem or .dem.bz2")
		return
	}

	if existing, err := s.cfg.Store.FindBySourcePath(absPath); err == nil && existing != nil && !req.Reparse {
		writeJSON(w, http.StatusOK, map[string]any{"demo": existing, "existing": true})
		return
	}

	id := newID("demo")
	if existing, err := s.cfg.Store.FindBySourcePath(absPath); err == nil && existing != nil {
		id = existing.ID
	}

	match, err := parser.ParseDemo(id, absPath)
	if err != nil {
		writeErr(w, http.StatusBadRequest, fmt.Sprintf("failed to parse demo: %v", err))
		return
	}
	if err := s.cfg.Store.SaveMatch(match, false); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"demo": match.Metadata})
}

func (s *Server) handleGetDemo(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	detail, err := s.cfg.Store.GetDemo(id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "demo not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) handleReparseDemo(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	detail, err := s.cfg.Store.GetDemo(id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "demo not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if detail.Metadata.SourcePath == "" {
		writeErr(w, http.StatusBadRequest, "demo has no source path")
		return
	}
	match, err := parser.ParseDemo(id, detail.Metadata.SourcePath)
	if err != nil {
		writeErr(w, http.StatusBadRequest, fmt.Sprintf("reparse failed: %v", err))
		return
	}
	match.Metadata.Filename = detail.Metadata.Filename
	if err := s.cfg.Store.SaveMatch(match, false); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"demo": match.Metadata})
}

func (s *Server) handleDeleteDemo(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	err := s.cfg.Store.DeleteDemo(id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "demo not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func serveGzipBytes(w http.ResponseWriter, r *http.Request, contentType string, gzData []byte) {
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Vary", "Accept-Encoding")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(gzData)
		return
	}
	zr, err := gzip.NewReader(bytes.NewReader(gzData))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer zr.Close()
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, zr)
}

func (s *Server) handleGetRound(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	roundNum, err := strconv.Atoi(r.PathValue("round"))
	if err != nil || roundNum < 1 {
		writeErr(w, http.StatusBadRequest, "invalid round number")
		return
	}
	gzData, err := s.cfg.Store.LoadRoundReplayGzip(id, roundNum)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "round not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	serveGzipBytes(w, r, "application/json; charset=utf-8", gzData)
}

func (s *Server) handleListBookmarks(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	bms, err := s.cfg.Store.ListBookmarks(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"bookmarks": bms})
}

func (s *Server) handleCreateBookmark(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req struct {
		Round      int    `json:"round_number"`
		Tick       int    `json:"tick"`
		Label      string `json:"label"`
		Note       string `json:"note"`
		CameraMode string `json:"camera_mode"`
		PlayerSlot int    `json:"player_slot"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	req.Label = strings.TrimSpace(req.Label)
	if req.Label == "" || req.Round < 1 || req.Tick < 0 {
		writeErr(w, http.StatusBadRequest, "label, round_number >= 1, and tick >= 0 are required")
		return
	}
	bm, err := s.cfg.Store.CreateBookmark(store.Bookmark{
		DemoID:     id,
		Round:      req.Round,
		Tick:       req.Tick,
		Label:      req.Label,
		Note:       strings.TrimSpace(req.Note),
		CameraMode: req.CameraMode,
		PlayerSlot: req.PlayerSlot,
	})
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "demo not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"bookmark": bm})
}

func (s *Server) handleDeleteBookmark(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	bmID := r.PathValue("bookmarkId")
	err := s.cfg.Store.DeleteBookmark(id, bmID)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "bookmark not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (s *Server) handleGetMapMesh(w http.ResponseWriter, r *http.Request) {
	mapName := r.PathValue("mapName")
	if !validNameRe.MatchString(mapName) {
		writeErr(w, http.StatusBadRequest, "invalid map name")
		return
	}

	cachePath := filepath.Join(s.cfg.Store.DataDir(), "cache", fmt.Sprintf("geo_%s.csmsh1.gz", mapName))
	if cached, err := os.ReadFile(cachePath); err == nil {
		w.Header().Set("Cache-Control", "public, max-age=86400")
		serveGzipBytes(w, r, "application/octet-stream", cached)
		return
	}

	geoPath := csgeo.FindGeoFile(mapName, s.allAssetDirs())
	if geoPath == "" {
		writeErr(w, http.StatusNotFound, "geo_not_found")
		return
	}

	s.geoMu.Lock()
	defer s.geoMu.Unlock()

	// Re-check cache after lock
	if cached, err := os.ReadFile(cachePath); err == nil {
		w.Header().Set("Cache-Control", "public, max-age=86400")
		serveGzipBytes(w, r, "application/octet-stream", cached)
		return
	}

	grid, err := csgeo.LoadFile(geoPath)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, fmt.Sprintf("load geo: %v", err))
		return
	}
	mesh, err := grid.GreedyMesh()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, fmt.Sprintf("mesh geo: %v", err))
		return
	}
	gzBytes, err := mesh.MarshalGzip()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, fmt.Sprintf("encode mesh: %v", err))
		return
	}
	_ = os.WriteFile(cachePath, gzBytes, 0644)

	w.Header().Set("Cache-Control", "public, max-age=86400")
	serveGzipBytes(w, r, "application/octet-stream", gzBytes)
}

func saveValidatedGLB(r *http.Request, w http.ResponseWriter, destPath string) error {
	r.Body = http.MaxBytesReader(w, r.Body, MaxUploadAssetBytes)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		return fmt.Errorf("invalid upload form: %w", err)
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		return errors.New("missing multipart field 'file'")
	}
	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, MaxUploadAssetBytes+1))
	if err != nil {
		return err
	}
	if len(data) < 12 || string(data[:4]) != "glTF" {
		return errors.New("invalid GLB file: missing glTF binary header")
	}
	if err := os.MkdirAll(filepath.Dir(destPath), 0755); err != nil {
		return err
	}
	return os.WriteFile(destPath, data, 0644)
}

func (s *Server) handleUploadMapAsset(w http.ResponseWriter, r *http.Request) {
	mapName := r.PathValue("mapName")
	if !validNameRe.MatchString(mapName) {
		writeErr(w, http.StatusBadRequest, "invalid map name")
		return
	}
	dest := filepath.Join(s.cfg.Store.DataDir(), "assets", "maps", mapName+".glb")
	if err := saveValidatedGLB(r, w, dest); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"map_name": mapName, "url": "/api/assets/maps/" + mapName})
}

func (s *Server) handleGetMapAsset(w http.ResponseWriter, r *http.Request) {
	mapName := r.PathValue("mapName")
	if !validNameRe.MatchString(mapName) {
		writeErr(w, http.StatusBadRequest, "invalid map name")
		return
	}
	p := filepath.Join(s.cfg.Store.DataDir(), "assets", "maps", mapName+".glb")
	if _, err := os.Stat(p); err != nil {
		discovered := csgeo.FindGlbFile(mapName, s.allAssetDirs())
		if discovered == "" {
			writeErr(w, http.StatusNotFound, "custom map glb not found")
			return
		}
		p = discovered
	}
	w.Header().Set("Content-Type", "model/gltf-binary")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, p)
}

func (s *Server) handleGetRadarAsset(w http.ResponseWriter, r *http.Request) {
	mapName := r.PathValue("mapName")
	if !validNameRe.MatchString(mapName) {
		writeErr(w, http.StatusBadRequest, "invalid map name")
		return
	}
	layer := r.URL.Query().Get("layer")
	var p string
	if layer == "lower" {
		p = csgeo.FindLowerRadarFile(mapName, s.allAssetDirs())
	} else {
		p = csgeo.FindRadarFile(mapName, s.allAssetDirs())
	}
	if p == "" {
		writeErr(w, http.StatusNotFound, "radar image not found")
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, p)
}

func (s *Server) handleGetMapRadar(w http.ResponseWriter, r *http.Request) {
	mapName := r.PathValue("mapName")
	if !validNameRe.MatchString(mapName) {
		writeErr(w, http.StatusBadRequest, "invalid map name")
		return
	}
	dirs := s.allAssetDirs()
	hasImage := csgeo.FindRadarFile(mapName, dirs) != ""
	hasLower := csgeo.FindLowerRadarFile(mapName, dirs) != ""
	overview := csgeo.LookupRadarOverview(mapName)

	imageUrl := ""
	if hasImage {
		imageUrl = "/api/assets/radars/" + mapName
	}
	lowerUrl := ""
	if hasLower {
		lowerUrl = "/api/assets/radars/" + mapName + "?layer=lower"
	}

	cachePath := filepath.Join(s.cfg.Store.DataDir(), "cache", fmt.Sprintf("radar_%s.json", mapName))
	if cached, err := os.ReadFile(cachePath); err == nil {
		var contour csgeo.RadarContour
		if json.Unmarshal(cached, &contour) == nil {
			writeJSON(w, http.StatusOK, map[string]any{
				"map_name":        mapName,
				"image_url":       imageUrl,
				"lower_image_url": lowerUrl,
				"overview":        overview,
				"contour":         contour,
			})
			return
		}
	}

	geoPath := csgeo.FindGeoFile(mapName, dirs)
	if geoPath == "" {
		if hasImage {
			writeJSON(w, http.StatusOK, map[string]any{
				"map_name":        mapName,
				"image_url":       imageUrl,
				"lower_image_url": lowerUrl,
				"overview":        overview,
			})
			return
		}
		writeErr(w, http.StatusNotFound, "radar_not_found")
		return
	}
	grid, err := csgeo.LoadFile(geoPath)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, fmt.Sprintf("load geo: %v", err))
		return
	}
	contour := grid.BuildRadarContour(mapName)
	if raw, err := json.Marshal(contour); err == nil {
		_ = os.WriteFile(cachePath, raw, 0644)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"map_name":        mapName,
		"image_url":       imageUrl,
		"lower_image_url": lowerUrl,
		"overview":        overview,
		"contour":         contour,
	})
}

func (s *Server) handleListAssetDirs(w http.ResponseWriter, r *http.Request) {
	saved, err := s.cfg.Store.ListAssetDirs()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if saved == nil {
		saved = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"dirs":        saved,
		"custom_maps": s.listCustomMaps(),
		"geo_maps":    csgeo.ListAvailableMaps(s.allAssetDirs()),
	})
}

func (s *Server) handleAddAssetDir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 8*1024)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	p := strings.TrimSpace(req.Path)
	if p == "" {
		writeErr(w, http.StatusBadRequest, "path is required")
		return
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid path")
		return
	}
	st, err := os.Stat(abs)
	if err != nil || !st.IsDir() {
		writeErr(w, http.StatusBadRequest, "directory not found on disk")
		return
	}
	if err := s.cfg.Store.AddAssetDir(abs); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"path":        abs,
		"custom_maps": s.listCustomMaps(),
		"geo_maps":    csgeo.ListAvailableMaps(s.allAssetDirs()),
	})
}

func (s *Server) handleDeleteAssetDir(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimSpace(r.URL.Query().Get("path"))
	if p == "" {
		writeErr(w, http.StatusBadRequest, "path query param is required")
		return
	}
	if err := s.cfg.Store.RemoveAssetDir(p); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (s *Server) handleDeleteMapAsset(w http.ResponseWriter, r *http.Request) {
	mapName := r.PathValue("mapName")
	if !validNameRe.MatchString(mapName) {
		writeErr(w, http.StatusBadRequest, "invalid map name")
		return
	}
	p := filepath.Join(s.cfg.Store.DataDir(), "assets", "maps", mapName+".glb")
	_ = os.Remove(p)
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (s *Server) handleUploadPlayerAsset(w http.ResponseWriter, r *http.Request) {
	dest := filepath.Join(s.cfg.Store.DataDir(), "assets", "players", "custom_player.glb")
	if err := saveValidatedGLB(r, w, dest); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"url": "/api/assets/player"})
}

func (s *Server) handleGetPlayerAsset(w http.ResponseWriter, r *http.Request) {
	p := filepath.Join(s.cfg.Store.DataDir(), "assets", "players", "custom_player.glb")
	if _, err := os.Stat(p); err != nil {
		writeErr(w, http.StatusNotFound, "custom player glb not found")
		return
	}
	w.Header().Set("Content-Type", "model/gltf-binary")
	http.ServeFile(w, r, p)
}

func (s *Server) handleDeletePlayerAsset(w http.ResponseWriter, r *http.Request) {
	p := filepath.Join(s.cfg.Store.DataDir(), "assets", "players", "custom_player.glb")
	_ = os.Remove(p)
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (s *Server) handleGetRolePlayerAsset(w http.ResponseWriter, r *http.Request) {
	role := r.PathValue("role")
	if !validNameRe.MatchString(role) {
		writeErr(w, http.StatusBadRequest, "invalid player role")
		return
	}
	p := s.findRoleOrWeaponGlb("players", role)
	if p == "" {
		writeErr(w, http.StatusNotFound, "player glb not found")
		return
	}
	w.Header().Set("Content-Type", "model/gltf-binary")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, p)
}

func (s *Server) handleGetWeaponAsset(w http.ResponseWriter, r *http.Request) {
	weaponName := r.PathValue("weaponName")
	if !validNameRe.MatchString(weaponName) {
		writeErr(w, http.StatusBadRequest, "invalid weapon name")
		return
	}
	p := s.findRoleOrWeaponGlb("weapons", weaponName)
	if p == "" {
		writeErr(w, http.StatusNotFound, "weapon glb not found")
		return
	}
	w.Header().Set("Content-Type", "model/gltf-binary")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, p)
}

func (s *Server) handleGetSkyboxAsset(w http.ResponseWriter, r *http.Request) {
	skyName := r.PathValue("skyName")
	if !validNameRe.MatchString(skyName) {
		writeErr(w, http.StatusBadRequest, "invalid skybox name")
		return
	}
	p, mime := s.findSkyboxAsset(skyName)
	if p == "" {
		writeErr(w, http.StatusNotFound, "skybox texture not found")
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, p)
}

func hudAssetSpec(group, filename string) (string, string) {
	ext := filepath.Ext(filename)
	if !validNameRe.MatchString(strings.TrimSuffix(filename, ext)) {
		return "", ""
	}
	if group == "fonts" {
		switch ext {
		case ".otf", ".ttf", ".woff2":
			return filepath.Join("fonts", filename), "font/" + ext[1:]
		}
	}
	if ext == ".svg" && (group == "equipment" || group == "deathnotice" || group == "hud") {
		return filepath.Join("icons", group, filename), "image/svg+xml"
	}
	return "", ""
}

func (s *Server) hudAssetDirs() []string {
	return append([]string{filepath.Join(s.cfg.Store.DataDir(), "assets")}, s.allAssetDirs()...)
}

func (s *Server) listHUDAssets() []string {
	files := make([]string, 0)
	seen := make(map[string]bool)
	for _, root := range s.hudAssetDirs() {
		for _, group := range []string{"fonts", "equipment", "deathnotice", "hud"} {
			subdir := group
			if group != "fonts" {
				subdir = filepath.Join("icons", group)
			}
			entries, _ := os.ReadDir(filepath.Join(root, subdir))
			for _, entry := range entries {
				key := group + "/" + entry.Name()
				if entry.Type().IsRegular() && !seen[key] {
					if _, mime := hudAssetSpec(group, entry.Name()); mime != "" {
						files = append(files, key)
						seen[key] = true
					}
				}
			}
		}
	}
	sort.Strings(files)
	return files
}

func (s *Server) handleGetHUDAsset(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("filename")
	path, mime := hudAssetSpec(r.PathValue("group"), name)
	if path == "" {
		writeErr(w, http.StatusNotFound, "HUD asset not found")
		return
	}
	for _, dir := range s.hudAssetDirs() {
		root, err := os.OpenRoot(dir)
		if err != nil {
			continue
		}
		f, err := root.Open(path)
		root.Close()
		if err != nil {
			continue
		}
		st, err := f.Stat()
		if err != nil || !st.Mode().IsRegular() {
			f.Close()
			continue
		}
		defer f.Close()
		w.Header().Set("Content-Type", mime)
		w.Header().Set("Cache-Control", "private, max-age=86400")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if mime == "image/svg+xml" {
			w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
		}
		http.ServeContent(w, r, name, st.ModTime(), f)
		return
	}
	writeErr(w, http.StatusNotFound, "HUD asset not found")
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeErr(w, http.StatusNotFound, "api endpoint not found")
		return
	}
	clean := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
	if clean == "." || clean == "" {
		clean = "index.html"
	}
	full := filepath.Join(s.cfg.StaticDir, clean)
	if st, err := os.Stat(full); err == nil && !st.IsDir() {
		http.ServeFile(w, r, full)
		return
	}
	// SPA fallback
	index := filepath.Join(s.cfg.StaticDir, "index.html")
	if _, err := os.Stat(index); err == nil {
		http.ServeFile(w, r, index)
		return
	}
	http.NotFound(w, r)
}
