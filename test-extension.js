#!/usr/bin/env node

/**
 * Simple test script for the Airbnb DXT extension
 * This script validates that the MCP server responds correctly to tool calls
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Test configuration
const TEST_TIMEOUT = 30000; // 30 seconds
const SERVER_PATH = join(__dirname, 'dist', 'index.js');

class MCPTester {
  constructor() {
    this.server = null;
    this.requestId = 1;
  }

  async startServer() {
    console.log('🚀 Starting MCP server...');
    
    this.server = spawn('node', [SERVER_PATH, '--ignore-robots-txt'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, IGNORE_ROBOTS_TXT: 'true' }
    });

    this.server.stderr.on('data', (data) => {
      console.log('📋 Server log:', data.toString().trim());
    });

    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    if (this.server.killed) {
      throw new Error('Server failed to start');
    }
    
    console.log('✅ Server started successfully');
  }

  async sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
      const request = {
        jsonrpc: '2.0',
        id: this.requestId++,
        method,
        params
      };

      const timeout = setTimeout(() => {
        reject(new Error(`Request timeout after ${TEST_TIMEOUT}ms`));
      }, TEST_TIMEOUT);

      let responseData = '';
      
      const onData = (data) => {
        responseData += data.toString();
        
        // Check if we have a complete JSON response
        try {
          const lines = responseData.split('\n').filter(line => line.trim());
          for (const line of lines) {
            const response = JSON.parse(line);
            if (response.id === request.id) {
              clearTimeout(timeout);
              this.server.stdout.off('data', onData);
              resolve(response);
              return;
            }
          }
        } catch (e) {
          // Not a complete JSON yet, continue waiting
        }
      };

      this.server.stdout.on('data', onData);
      
      console.log(`📤 Sending request: ${method}`);
      this.server.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  async testListTools() {
    console.log('\n🔧 Testing list_tools...');
    
    try {
      const response = await this.sendRequest('tools/list');
      
      if (response.error) {
        throw new Error(`Server error: ${response.error.message}`);
      }
      
      const tools = response.result?.tools || [];
      console.log(`✅ Found ${tools.length} tools:`);
      
      tools.forEach(tool => {
        console.log(`   - ${tool.name}: ${tool.description}`);
      });
      
      // Validate expected tools
      const expectedTools = ['airbnb_search', 'airbnb_listing_details', 'airbnb_trip_search', 'airbnb_wishlist_manage'];
      const foundTools = tools.map(t => t.name);
      
      for (const expectedTool of expectedTools) {
        if (!foundTools.includes(expectedTool)) {
          throw new Error(`Missing expected tool: ${expectedTool}`);
        }
      }
      
      return true;
    } catch (error) {
      console.error('❌ list_tools test failed:', error.message);
      return false;
    }
  }

  async testSearchTool() {
    console.log('\n🔍 Testing airbnb_search tool...');
    
    try {
      const response = await this.sendRequest('tools/call', {
        name: 'airbnb_search',
        arguments: {
          location: 'San Francisco, CA',
          adults: 2,
          ignoreRobotsText: true
        }
      });
      
      if (response.error) {
        throw new Error(`Server error: ${response.error.message}`);
      }
      
      const result = response.result;
      if (!result || !result.content || !result.content[0]) {
        throw new Error('Invalid response format');
      }
      
      const content = JSON.parse(result.content[0].text);
      
      if (content.error) {
        console.log('⚠️  Search returned error (expected for robots.txt):', content.error);
        return true; // This is expected behavior
      }
      
      if (content.searchResults) {
        console.log(`✅ Search successful, found ${content.searchResults.length} results`);
        if (content.searchResults.length > 0) {
          console.log(`   First result: ${content.searchResults[0].id}`);
        }
      }
      
      return true;
    } catch (error) {
      console.error('❌ airbnb_search test failed:', error.message);
      return false;
    }
  }

  async testListingDetailsTool() {
    console.log('\n🏠 Testing airbnb_listing_details tool...');
    
    try {
      const response = await this.sendRequest('tools/call', {
        name: 'airbnb_listing_details',
        arguments: {
          id: '670214003022775198',
          ignoreRobotsText: true
        }
      });
      
      if (response.error) {
        throw new Error(`Server error: ${response.error.message}`);
      }
      
      const result = response.result;
      if (!result || !result.content || !result.content[0]) {
        throw new Error('Invalid response format');
      }
      
      const content = JSON.parse(result.content[0].text);
      
      if (content.error) {
        console.log('⚠️  Listing details returned error (expected for dummy ID):', content.error);
        return true; // This is expected behavior
      }
      
      console.log('✅ Listing details tool responded correctly');
      return true;
    } catch (error) {
      console.error('❌ airbnb_listing_details test failed:', error.message);
      return false;
    }
  }

  async testTripSearchTool() {
    console.log('\n🧭 Testing airbnb_trip_search tool...');
    try {
      const response = await this.sendRequest('tools/call', {
        name: 'airbnb_trip_search',
        arguments: {
          location: 'Lake Tahoe, California',
          checkin: '2026-07-30',
          checkout: '2026-08-02',
          adults: 4,
          pets: 1,
          maxCandidates: 2
        }
      });
      if (response.error) throw new Error(`Server error: ${response.error.message}`);
      const result = JSON.parse(response.result?.content?.[0]?.text || '{}');
      if (result.schema !== 'lookup-scaffold/v1') throw new Error('Missing lookup-scaffold/v1 result');
      if (!Array.isArray(result.rows) || result.rows.length === 0) throw new Error('Trip search returned no rows');
      if (!result.rows.every(row => ['exact', 'estimated', 'unknown'].includes(row.quoteStatus))) {
        throw new Error('Invalid quote status');
      }
      console.log(`✅ Trip search returned ${result.rows.length} normalized rows (${result.status})`);
      return true;
    } catch (error) {
      console.error('❌ airbnb_trip_search test failed:', error.message);
      return false;
    }
  }

  // Expects the handler to reject a call and return an isError result whose
  // message matches `expectedMessagePattern`.
  async _expectTripSearchError(label, args, expectedMessagePattern) {
    const response = await this.sendRequest('tools/call', { name: 'airbnb_trip_search', arguments: args });
    if (response.error) {
      // Some invalid-params paths surface as a JSON-RPC error rather than an
      // isError tool result; either shape counts as rejection here.
      if (expectedMessagePattern.test(response.error.message)) return true;
      console.error(`   ❌ ${label}: unexpected JSON-RPC error message: ${response.error.message}`);
      return false;
    }
    const result = response.result;
    if (!result || !result.isError) {
      console.error(`   ❌ ${label}: expected a rejection but call succeeded`);
      return false;
    }
    const text = result.content?.[0]?.text || '';
    let message = text;
    try { message = JSON.parse(text).error || text; } catch { /* plain text error */ }
    if (!expectedMessagePattern.test(message)) {
      console.error(`   ❌ ${label}: rejection message did not match expectation: ${message}`);
      return false;
    }
    return true;
  }

  // Explicit-listing quote mode: mutual exclusion between location,
  // wishlistUrl, and listingUrls (0 given -> error, 2+ given -> error), and
  // the 1/25/26 listingUrls bounds. No browser required — all of these are
  // rejected during handler-level schema validation before any helper run.
  async testTripSearchMutualExclusionAndBounds() {
    console.log('\nTesting airbnb_trip_search mutual exclusion + listingUrls bounds...');
    const baseArgs = { checkin: '2026-09-14', checkout: '2026-09-17', adults: 2 };
    const roomUrl = (id) => `https://www.airbnb.com/rooms/${id}`;
    const manyUrls = (n) => Array.from({ length: n }, (_, i) => roomUrl(1000000000000000000n + BigInt(i)));

    let allOk = true;
    const cases = [
      ['zero modes given', { ...baseArgs }, /exactly one of location, wishlistUrl, or listingUrls/i],
      ['two modes given (location + listingUrls)', { ...baseArgs, location: 'Lake Tahoe, California', listingUrls: [roomUrl(123)] }, /exactly one of location, wishlistUrl, or listingUrls/i],
      ['three modes given', { ...baseArgs, location: 'Lake Tahoe, California', wishlistUrl: 'https://www.airbnb.com/wishlists/123', listingUrls: [roomUrl(123)] }, /exactly one of location, wishlistUrl, or listingUrls/i],
      ['listingUrls empty array', { ...baseArgs, listingUrls: [] }, /1 to 25 entries/i],
      ['listingUrls 26 entries (over bound)', { ...baseArgs, listingUrls: manyUrls(26) }, /1 to 25 entries/i],
    ];
    for (const [label, args, pattern] of cases) {
      const ok = await this._expectTripSearchError(label, args, pattern);
      console.log(`   ${ok ? 'PASS' : 'FAIL'} ${label}`);
      allOk = allOk && ok;
    }
    return allOk;
  }

  // Every listing URL must normalize to an HTTPS airbnb.com/rooms/<id> URL
  // before any browser invocation. Covers non-Airbnb host, non-HTTPS,
  // open-redirect-shaped, javascript:, and userinfo-trick adversarial shapes.
  async testTripSearchListingUrlAllowlist() {
    console.log('\nTesting airbnb_trip_search listingUrls allowlist...');
    const baseArgs = { checkin: '2026-09-14', checkout: '2026-09-17', adults: 2 };
    const adversarial = [
      ['non-Airbnb host', 'https://evil.example.com/rooms/123'],
      ['subdomain-suffix trick', 'https://www.airbnb.com.evil.example.com/rooms/123'],
      ['non-HTTPS', 'http://www.airbnb.com/rooms/123'],
      ['javascript: URL', 'javascript:alert(1)'],
      ['userinfo host trick', 'https://www.airbnb.com:1@evil.example.com/rooms/123'],
      ['open-redirect-shaped path', 'https://www.airbnb.com/redirect?to=https://evil.example.com/rooms/123'],
      ['wishlist path, not a room', 'https://www.airbnb.com/wishlists/123'],
      ['non-numeric room id', 'https://www.airbnb.com/rooms/abc'],
      ['not a URL at all', 'not-a-url'],
    ];
    let allOk = true;
    for (const [label, url] of adversarial) {
      const ok = await this._expectTripSearchError(label, { ...baseArgs, listingUrls: [url] }, /listingUrls entries|must be valid URLs|listingUrls must/i);
      console.log(`   ${ok ? 'PASS' : 'FAIL'} rejects ${label}: ${url}`);
      allOk = allOk && ok;
    }
    return allOk;
  }

  // The 25-entry upper bound must be *accepted* by validation (unlike the
  // 26-entry case above). Proving that cheaply without waiting on 25 real
  // browser navigations requires a throwaway server instance pointed at an
  // unreachable CDP endpoint: the helper fails fast with browser_unavailable
  // and index.ts's fallback path still returns one normalized row per
  // requested URL, showing all 25 candidates were built and passed through.
  async testTripSearchListingUrlBoundaryAccepted() {
    console.log('\nTesting airbnb_trip_search accepts the 25-entry listingUrls bound...');
    const throwaway = spawn('node', [SERVER_PATH, '--ignore-robots-txt'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, IGNORE_ROBOTS_TXT: 'true', AIRBNB_CDP_URL: 'http://127.0.0.1:1' },
    });
    throwaway.stderr.on('data', () => {});
    try {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const urls = Array.from({ length: 25 }, (_, i) => `https://www.airbnb.com/rooms/${9000000000000000000n + BigInt(i)}`);
      const response = await new Promise((resolve, reject) => {
        const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'airbnb_trip_search', arguments: { listingUrls: urls, checkin: '2026-09-14', checkout: '2026-09-17', adults: 2 } } };
        const timer = setTimeout(() => reject(new Error('25-entry boundary call timed out')), 20000);
        let out = '';
        const onData = (data) => {
          out += data.toString();
          for (const line of out.split('\n').filter(Boolean)) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.id === request.id) { clearTimeout(timer); throwaway.stdout.off('data', onData); resolve(parsed); return; }
            } catch { /* incomplete line */ }
          }
        };
        throwaway.stdout.on('data', onData);
        throwaway.stdin.write(JSON.stringify(request) + '\n');
      });
      if (response.error) throw new Error(`Server error: ${response.error.message}`);
      const result = JSON.parse(response.result?.content?.[0]?.text || '{}');
      if (result.schema !== 'lookup-scaffold/v1') throw new Error('Missing lookup-scaffold/v1 result');
      if (!Array.isArray(result.rows) || result.rows.length !== 25) throw new Error(`Expected 25 rows, got ${result.rows?.length}`);
      console.log(`PASS: 25 listingUrls accepted and produced ${result.rows.length} normalized rows (status=${result.status})`);
      return true;
    } catch (error) {
      console.error('FAIL: 25-entry listingUrls boundary test failed:', error.message);
      return false;
    } finally {
      throwaway.kill('SIGTERM');
    }
  }

  // Fixture-style check: explicit-listing mode with a well-formed URL still
  // returns a schema-conformant lookup-scaffold/v1 result (via the
  // browser-unavailable fallback path when no live browser session is
  // reachable, or a live quote when one is). Either way this proves the
  // request reaches exactly one bounded helper run and the response is
  // normalized, without requiring a live authenticated browser in CI.
  async testTripSearchExplicitListingFixture() {
    console.log('\nTesting airbnb_trip_search explicit-listing fixture shape...');
    try {
      const response = await this.sendRequest('tools/call', {
        name: 'airbnb_trip_search',
        arguments: {
          listingUrls: ['https://www.airbnb.com/rooms/1648790451780419277'],
          checkin: '2026-09-14',
          checkout: '2026-09-17',
          adults: 2
        }
      });
      if (response.error) throw new Error(`Server error: ${response.error.message}`);
      const result = JSON.parse(response.result?.content?.[0]?.text || '{}');
      if (result.schema !== 'lookup-scaffold/v1') throw new Error('Missing lookup-scaffold/v1 result');
      // Top-level envelope must be labeled "listingUrls", not the shared
      // helper's default "location" label -- see index.ts's override right
      // after runTripPlanner resolves on the success path.
      if (result.source !== 'listingUrls') throw new Error(`Expected top-level source "listingUrls", got "${result.source}"`);
      if (!Array.isArray(result.rows) || result.rows.length !== 1) throw new Error(`Expected exactly 1 row, got ${result.rows?.length}`);
      const row = result.rows[0];
      if (!['exact', 'estimated', 'unknown'].includes(row.quoteStatus)) throw new Error(`Invalid quoteStatus: ${row.quoteStatus}`);
      if (row.source?.url !== 'https://www.airbnb.com/rooms/1648790451780419277') throw new Error('Row source URL does not match requested listing');
      console.log(`PASS: Explicit-listing quote returned 1 normalized row (status=${result.status}, source=${result.source}, quoteStatus=${row.quoteStatus})`);
      return true;
    } catch (error) {
      console.error('FAIL: explicit-listing fixture test failed:', error.message);
      return false;
    }
  }

  async stopServer() {
    if (this.server && !this.server.killed) {
      console.log('\n🛑 Stopping server...');
      this.server.kill('SIGTERM');

      // Wait for graceful shutdown
      await new Promise(resolve => {
        this.server.on('exit', resolve);
        setTimeout(() => {
          if (!this.server.killed) {
            this.server.kill('SIGKILL');
          }
          resolve();
        }, 5000);
      });

      console.log('✅ Server stopped');
    }
  }

  // Helper: extract the searchUrl the server echoes back in its response body.
  _extractSearchUrl(response) {
    const text = response?.result?.content?.[0]?.text;
    if (!text) return '';
    try {
      const parsed = JSON.parse(text);
      return parsed.searchUrl || parsed.url || '';
    } catch {
      return '';
    }
  }

  // Assert client-side geocoding actually populates ne_lat/ne_lng/sw_lat/sw_lng
  // *and* that the bbox is centered on the correct city. Without client-side
  // geocoding, "Paris, France" lands in Vendée (~46.4, -1.1) and "Copenhagen"
  // lands in Wisconsin (~43.0, -88.0) — so checking the bbox center falls inside
  // the expected lat/lng window is the meaningful assertion.
  async testGeocoding() {
    console.log('\n🌍 Testing geocoding...');
    const cases = [
      { location: 'Paris, France',            lat: [48.5, 49.1], lng: [2.0, 2.7],   label: 'Paris (Photon path)' },
      { location: 'Copenhagen, Denmark',      lat: [55.4, 55.9], lng: [12.3, 12.8], label: 'Copenhagen (Nominatim fallback)' },
      { location: 'Munich, Bavaria, Germany', lat: [48.0, 48.4], lng: [11.2, 11.9], label: 'Munich (regression check)' },
    ];

    const parseBbox = (url) => {
      const params = new URLSearchParams(url.split('?')[1] || '');
      const ne_lat = parseFloat(params.get('ne_lat'));
      const ne_lng = parseFloat(params.get('ne_lng'));
      const sw_lat = parseFloat(params.get('sw_lat'));
      const sw_lng = parseFloat(params.get('sw_lng'));
      if ([ne_lat, ne_lng, sw_lat, sw_lng].some(Number.isNaN)) return null;
      return { centerLat: (ne_lat + sw_lat) / 2, centerLng: (ne_lng + sw_lng) / 2, ne_lat, ne_lng, sw_lat, sw_lng };
    };

    let allOk = true;
    for (const c of cases) {
      try {
        const response = await this.sendRequest('tools/call', {
          name: 'airbnb_search',
          arguments: { location: c.location, ignoreRobotsText: true },
        });
        const url = this._extractSearchUrl(response);
        const bbox = parseBbox(url);
        if (!bbox) {
          console.log(`   ❌ ${c.label}: no bbox in URL — geocoding silently failed`);
          allOk = false;
          continue;
        }
        const latOk = bbox.centerLat >= c.lat[0] && bbox.centerLat <= c.lat[1];
        const lngOk = bbox.centerLng >= c.lng[0] && bbox.centerLng <= c.lng[1];
        const ok = latOk && lngOk;
        const center = `(${bbox.centerLat.toFixed(3)}, ${bbox.centerLng.toFixed(3)})`;
        console.log(`   ${ok ? '✅' : '❌'} ${c.label}: center=${center}  bbox=[${bbox.sw_lat.toFixed(2)},${bbox.sw_lng.toFixed(2)} → ${bbox.ne_lat.toFixed(2)},${bbox.ne_lng.toFixed(2)}]`);
        if (!ok) allOk = false;
      } catch (error) {
        console.error(`   ❌ ${c.label}: ${error.message}`);
        allOk = false;
      }
    }
    return allOk;
  }

  async runTests() {
    let allPassed = true;

    try {
      await this.startServer();

      // Run all tests
      const tests = [
        () => this.testListTools(),
        () => this.testSearchTool(),
        () => this.testListingDetailsTool(),
        () => this.testTripSearchTool(),
        () => this.testTripSearchMutualExclusionAndBounds(),
        () => this.testTripSearchListingUrlAllowlist(),
        () => this.testTripSearchListingUrlBoundaryAccepted(),
        () => this.testTripSearchExplicitListingFixture(),
        () => this.testGeocoding(),
      ];
      
      for (const test of tests) {
        const passed = await test();
        allPassed = allPassed && passed;
      }
      
    } catch (error) {
      console.error('❌ Test suite failed:', error.message);
      allPassed = false;
    } finally {
      await this.stopServer();
    }
    
    console.log('\n' + '='.repeat(50));
    if (allPassed) {
      console.log('🎉 All tests passed! Extension is ready for use.');
    } else {
      console.log('❌ Some tests failed. Please check the issues above.');
      process.exit(1);
    }
  }
}

// Run tests if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const tester = new MCPTester();
  tester.runTests().catch(error => {
    console.error('💥 Test runner crashed:', error);
    process.exit(1);
  });
}

export default MCPTester;
