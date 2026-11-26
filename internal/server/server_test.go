package server

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"cs2-3d-demo-manager/internal/parser"
	"cs2-3d-demo-manager/internal/store"
)

func makeGeoBin(shape [3]int32) []byte {
	total := int(shape[0] * shape[1] * shape[2])
	bits := make([]byte, (total+7)/8)
	bits[0] = 0b10000000 // cell (0,0,0) solid
	buf := make([]byte, 34+len(bits))
	copy(buf[:6], "CSGEO1")
	for i := 0; i < 3; i++ {
		binary.LittleEndian.PutUint32(buf[6+i*4:10+i*4], uint32(shape[i]))
		binary.LittleEndian.PutUint32(buf[18+i*4:22+i*4], math.Float32bits(0))
	}
	binary.LittleEndian.PutUint32(buf[30:34], math.Float32bits(8))
	copy(buf[34:], bits)
	return buf
}

func TestServerAPIEndToEnd(t *testing.T) {
	tmp := t.TempDir()
	geoDir := filepath.Join(tmp, "geo")
	if err := os.MkdirAll(geoDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(geoDir, "geo_de_test.bin"), makeGeoBin([3]int32{2, 2, 2}), 0644); err != nil {
		t.Fatal(err)
	}

	st, err := store.Open(filepath.Join(tmp, "data"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	srv := New(Config{
		Store:   st,
		GeoDirs: []string{geoDir},
	})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// Seed one demo directly in store
	if err := st.SaveMatch(&parser.ParsedMatch{
		Metadata: parser.DemoMetadata{
			ID: "demo_1", Filename: "match.dem", SourcePath: "/tmp/match.dem", Format: "dem",
			FileSize: 512, MapName: "de_test", TickRate: 64, TotalTicks: 200, DurationSec: 3.1,
			ScoreCT: 13, ScoreT: 11, RoundCount: 1, KillCount: 1, ParsedAt: "2026-11-25T10:00:00Z", Status: "ready",
		},
		Players: []parser.PlayerSummary{{Slot: 0, SteamID: "76561198000000001", Name: "ZywOo", StartTeam: 3, Team: 3, Kills: 25, Deaths: 10}},
		Rounds:  []parser.RoundSummary{{RoundNumber: 1, StartTick: 10, FreezeEndTick: 20, EndTick: 100, OfficialEndTick: 110, WinnerTeam: 3, WinReason: "CT Elimination", ScoreCT: 1, ScoreT: 0, KillCount: 1, FrameCount: 1}},
		Kills:   []parser.KillEvent{{Round: 1, Tick: 50, KillerSlot: 0, KillerName: "ZywOo", KillerTeam: 3, VictimSlot: 1, VictimName: "Bot", VictimTeam: 2, Weapon: "AWP"}},
		RoundData: map[int]*parser.RoundReplay{
			1: {DemoID: "demo_1", RoundNumber: 1, TickRate: 64, Weapons: []string{"AWP"}, Frames: []parser.Frame{{Tick: 10, Players: [][]float64{{1, 3, 0, 0, 0, 0, 0, 100, 100, 0, 0, 0, 0, 0, 1}}}}},
		},
	}, false); err != nil {
		t.Fatal(err)
	}

	// Health check
	res, err := http.Get(ts.URL + "/api/health")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("health failed: %v %v", res, err)
	}
	res.Body.Close()

	// Search by player
	res, err = http.Get(ts.URL + "/api/demos?q=zywoo")
	if err != nil {
		t.Fatal(err)
	}
	var listResp struct {
		Demos []store.DemoListItem `json:"demos"`
	}
	_ = json.NewDecoder(res.Body).Decode(&listResp)
	res.Body.Close()
	if len(listResp.Demos) != 1 || listResp.Demos[0].ID != "demo_1" {
		t.Fatalf("expected 1 search result, got %+v", listResp.Demos)
	}

	// Map mesh endpoint
	res, err = http.Get(ts.URL + "/api/maps/de_test/mesh")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("mesh failed: %v %v", res, err)
	}
	meshBytes, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if len(meshBytes) < 34 || string(meshBytes[:6]) != "CSMSH1" {
		t.Fatalf("unexpected CSMSH1 payload len=%d", len(meshBytes))
	}

	// Upload custom GLB asset
	var mbuf bytes.Buffer
	mw := multipart.NewWriter(&mbuf)
	fw, _ := mw.CreateFormFile("file", "map.glb")
	_, _ = fw.Write([]byte("glTF\x02\x00\x00\x00\x10\x00\x00\x00test"))
	mw.Close()
	req, _ := http.NewRequest("POST", ts.URL+"/api/assets/maps/de_test", &mbuf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	res, err = http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != 201 {
		t.Fatalf("glb upload failed: %v %v", res, err)
	}
	res.Body.Close()

	// Create bookmark and verify persistence
	bmBody := bytes.NewBufferString(`{"round_number":1,"tick":50,"label":"AWP pick","note":"Mid","camera_mode":"pov","player_slot":0}`)
	res, err = http.Post(ts.URL+"/api/demos/demo_1/bookmarks", "application/json", bmBody)
	if err != nil || res.StatusCode != 201 {
		t.Fatalf("bookmark create failed: %v %v", res, err)
	}
	res.Body.Close()

	// Round replay endpoint
	res, err = http.Get(ts.URL + "/api/demos/demo_1/rounds/1")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("round get failed: %v %v", res, err)
	}
	var rr parser.RoundReplay
	_ = json.NewDecoder(res.Body).Decode(&rr)
	res.Body.Close()
	if len(rr.Frames) != 1 || rr.Frames[0].Tick != 10 {
		t.Fatalf("unexpected round frames: %+v", rr.Frames)
	}

	// Radar contour + overview metadata endpoint from CSGEO1 + local radar PNG
	_ = os.WriteFile(filepath.Join(tmp, "data", "assets", "radars", "de_nuke.png"), []byte("PNGFAKE"), 0644)
	_ = os.WriteFile(filepath.Join(tmp, "data", "assets", "radars", "de_nuke_lower.png"), []byte("PNGFAKELOWER"), 0644)
	res, err = http.Get(ts.URL + "/api/maps/de_nuke/radar")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("nuke radar failed: %v %v", res, err)
	}
	var nukeRadar struct {
		ImageURL      string `json:"image_url"`
		LowerImageURL string `json:"lower_image_url"`
		Overview      struct {
			Scale float64 `json:"scale"`
		} `json:"overview"`
	}
	_ = json.NewDecoder(res.Body).Decode(&nukeRadar)
	res.Body.Close()
	if nukeRadar.ImageURL == "" || nukeRadar.LowerImageURL == "" || nukeRadar.Overview.Scale != 7.0 {
		t.Fatalf("unexpected nuke radar response: %+v", nukeRadar)
	}

	res, err = http.Get(ts.URL + "/api/maps/de_test/radar")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("radar contour failed: %v %v", res, err)
	}
	var radarResp struct {
		MapName string `json:"map_name"`
		Contour struct {
			Width  int `json:"width"`
			Height int `json:"height"`
		} `json:"contour"`
	}
	_ = json.NewDecoder(res.Body).Decode(&radarResp)
	res.Body.Close()
	if radarResp.MapName != "de_test" || radarResp.Contour.Width == 0 {
		t.Fatalf("unexpected radar contour response: %+v", radarResp)
	}

	// Register local asset directory and auto-discover .glb
	extAssetDir := filepath.Join(tmp, "ext_maps")
	_ = os.MkdirAll(extAssetDir, 0755)
	_ = os.WriteFile(filepath.Join(extAssetDir, "de_custom.glb"), []byte("glTF\x02\x00\x00\x00\x10\x00\x00\x00disc"), 0644)
	res, err = http.Post(ts.URL+"/api/assets/dirs", "application/json", bytes.NewBufferString(`{"path":"`+extAssetDir+`"}`))
	if err != nil || res.StatusCode != 201 {
		t.Fatalf("add asset dir failed: %v %v", res, err)
	}
	res.Body.Close()
	res, err = http.Get(ts.URL + "/api/assets/maps/de_custom")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("auto-discovered glb fetch failed: %v %v", res, err)
	}
	res.Body.Close()

	// Role player, weapon GLB, and skybox endpoints + health discovery
	_ = os.MkdirAll(filepath.Join(tmp, "data", "assets", "players"), 0755)
	_ = os.MkdirAll(filepath.Join(tmp, "data", "assets", "weapons"), 0755)
	_ = os.MkdirAll(filepath.Join(tmp, "data", "assets", "skyboxes"), 0755)
	_ = os.WriteFile(filepath.Join(tmp, "data", "assets", "players", "ct_sas.glb"), []byte("glTF\x02\x00\x00\x00\x10\x00\x00\x00ct01"), 0644)
	_ = os.WriteFile(filepath.Join(tmp, "data", "assets", "weapons", "ak47.glb"), []byte("glTF\x02\x00\x00\x00\x10\x00\x00\x00ak47"), 0644)
	_ = os.WriteFile(filepath.Join(tmp, "data", "assets", "skyboxes", "de_nuke.webp"), []byte("RIFF\x00\x00\x00\x00WEBP"), 0644)

	res, err = http.Get(ts.URL + "/api/health")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("health check failed: %v", err)
	}
	var healthResp struct {
		PlayerModels []string `json:"player_models"`
		WeaponModels []string `json:"weapon_models"`
		Skyboxes     []string `json:"skyboxes"`
	}
	_ = json.NewDecoder(res.Body).Decode(&healthResp)
	res.Body.Close()
	if len(healthResp.PlayerModels) != 1 || healthResp.PlayerModels[0] != "ct_sas" {
		t.Fatalf("unexpected player_models: %+v", healthResp.PlayerModels)
	}
	if len(healthResp.WeaponModels) != 1 || healthResp.WeaponModels[0] != "ak47" {
		t.Fatalf("unexpected weapon_models: %+v", healthResp.WeaponModels)
	}
	if len(healthResp.Skyboxes) != 1 || healthResp.Skyboxes[0] != "de_nuke" {
		t.Fatalf("unexpected skyboxes: %+v", healthResp.Skyboxes)
	}

	res, err = http.Get(ts.URL + "/api/assets/skyboxes/de_nuke")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("get skybox failed: %v %v", res, err)
	}
	res.Body.Close()

	res, err = http.Get(ts.URL + "/api/assets/players/ct_sas")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("get role player glb failed: %v %v", res, err)
	}
	res.Body.Close()

	res, err = http.Get(ts.URL + "/api/assets/weapons/ak47")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("get weapon glb failed: %v %v", res, err)
	}
	res.Body.Close()

	res, err = http.Get(ts.URL + "/api/assets/weapons/bad.name")
	if err != nil || res.StatusCode != 400 {
		t.Fatalf("expected 400 for invalid weapon name, got %v", res)
	}
	res.Body.Close()

	// Delete demo
	req, _ = http.NewRequest("DELETE", ts.URL+"/api/demos/demo_1", nil)
	res, err = http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("delete demo failed: %v %v", res, err)
	}
	res.Body.Close()
}

func TestHUDAssetAPI(t *testing.T) {
	tmp := t.TempDir()
	assetsDir := filepath.Join(tmp, "assets")
	for name, content := range map[string]string{
		"fonts/stratum2-regular.otf":          "font-bytes",
		"fonts/stratum2bold_monodigit.ttf":    "digits-bytes",
		"icons/equipment/ak47.svg":            `<svg xmlns="http://www.w3.org/2000/svg"></svg>`,
		"icons/deathnotice/icon_headshot.svg": `<svg xmlns="http://www.w3.org/2000/svg"></svg>`,
		"icons/hud/health_cross.svg":          `<svg xmlns="http://www.w3.org/2000/svg"></svg>`,
		"icons/equipment/readme.txt":          "not an icon",
		"secret.html":                         "<html></html>",
	} {
		p := filepath.Join(assetsDir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}

	st, err := store.Open(filepath.Join(tmp, "data"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	srv := New(Config{Store: st, AssetDirs: []string{assetsDir}})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	get := func(path string) (*http.Response, string) {
		res, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(res.Body)
		res.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		return res, string(body)
	}

	for _, tc := range []struct{ path, wantType, wantBody string }{
		{"/api/assets/hud/fonts/stratum2-regular.otf", "font/otf", "font-bytes"},
		{"/api/assets/hud/fonts/stratum2bold_monodigit.ttf", "font/ttf", "digits-bytes"},
		{"/api/assets/hud/equipment/ak47.svg", "image/svg+xml", "<svg"},
		{"/api/assets/hud/deathnotice/icon_headshot.svg", "image/svg+xml", "<svg"},
		{"/api/assets/hud/hud/health_cross.svg", "image/svg+xml", "<svg"},
	} {
		res, body := get(tc.path)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("%s: status %d", tc.path, res.StatusCode)
		}
		if got := res.Header.Get("Content-Type"); got != tc.wantType {
			t.Fatalf("%s: content type %q", tc.path, got)
		}
		if !strings.Contains(body, tc.wantBody) {
			t.Fatalf("%s: body %q", tc.path, body)
		}
		if res.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("%s: missing nosniff", tc.path)
		}
	}

	for _, path := range []string{
		"/api/assets/hud/equipment/readme.txt",
		"/api/assets/hud/scripts/ak47.svg",
		"/api/assets/hud/fonts/%2e%2e%2fsecret.html",
		"/api/assets/hud/fonts/../../secret.html",
		"/api/assets/hud/equipment/missing.svg",
	} {
		res, _ := get(path)
		if res.StatusCode != http.StatusNotFound {
			t.Fatalf("%s: expected 404, got %d", path, res.StatusCode)
		}
	}

	healthRes, healthBody := get("/api/health")
	if healthRes.StatusCode != http.StatusOK {
		t.Fatalf("health status %d", healthRes.StatusCode)
	}
	var health struct {
		HUDAssets []string `json:"hud_assets"`
	}
	if err := json.Unmarshal([]byte(healthBody), &health); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"deathnotice/icon_headshot.svg",
		"equipment/ak47.svg",
		"fonts/stratum2-regular.otf",
		"fonts/stratum2bold_monodigit.ttf",
		"hud/health_cross.svg",
	}
	if strings.Join(health.HUDAssets, ",") != strings.Join(want, ",") {
		t.Fatalf("hud_assets = %v", health.HUDAssets)
	}
}
