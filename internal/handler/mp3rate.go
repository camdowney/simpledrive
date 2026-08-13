package handler

import (
	"bufio"
	"io"
	"os"
)

var mp3RatesV1 = [16]int{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0}
var mp3RatesV2 = [16]int{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0}
var mp3SampleRates = [4][3]int{{11025, 12000, 8000}, {}, {22050, 24000, 16000}, {44100, 48000, 32000}}

// Frames that disagree on bitrate leave a cut's length readable only from a Xing header.
func mp3Bitrates(path string) (constant bool, meanKbps int, ok bool) {
	f, err := os.Open(path)
	if err != nil {
		return false, 0, false
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 64*1024)
	skipID3(r)

	first, frames, total := 0, 0, 0
	constant = true
	for {
		kbps, body, err := mp3Frame(r)
		if err != nil {
			break
		}
		// A Xing/Info frame holds no audio and need not carry the rate the audio was encoded at.
		if frames == 0 && mp3SkipHeaderFrame(r, body) {
			continue
		}
		if first == 0 {
			first = kbps
		} else if kbps != first {
			constant = false
		}
		frames++
		total += kbps
		if _, err := r.Discard(body); err != nil {
			break
		}
	}
	if frames < 10 {
		return false, 0, false
	}
	return constant, total / frames, true
}

// An ID3v2 tag stores its size as four 7-bit groups.
func skipID3(r *bufio.Reader) {
	head, err := r.Peek(10)
	if err != nil || string(head[:3]) != "ID3" {
		return
	}
	size := 0
	for _, b := range head[6:10] {
		size = size<<7 | int(b&0x7F)
	}
	r.Discard(10 + size)
}

// mp3Frame consumes the next frame header, reporting its bitrate and the bytes of body that follow.
func mp3Frame(r *bufio.Reader) (kbps, body int, err error) {
	for {
		head, err := r.Peek(4)
		if err != nil {
			return 0, 0, io.EOF
		}
		ver, layer := head[1]>>3&3, head[1]>>1&3
		rateIdx, sampleIdx, pad := head[2]>>4, head[2]>>2&3, int(head[2]>>1&1)
		// Layer III is bits 01; version 01 and sample index 3 are reserved, as are rates 0 and 15.
		bad := head[0] != 0xFF || head[1]&0xE0 != 0xE0 || layer != 1 || ver == 1 ||
			sampleIdx == 3 || rateIdx == 0 || rateIdx == 15
		if !bad {
			v1 := ver == 3
			samples, table := 576, mp3RatesV2
			if v1 {
				samples, table = 1152, mp3RatesV1
			}
			kbps = table[rateIdx]
			size := samples/8*kbps*1000/mp3SampleRates[ver][sampleIdx] + pad
			if size >= 24 {
				if _, err := r.Discard(4); err != nil {
					return 0, 0, io.EOF
				}
				return kbps, size - 4, nil
			}
		}
		if _, err := r.Discard(1); err != nil {
			return 0, 0, io.EOF
		}
	}
}

// mp3SkipHeaderFrame consumes the body just entered if it is a Xing/Info tag rather than audio.
func mp3SkipHeaderFrame(r *bufio.Reader, body int) bool {
	span := body
	if span > 64 {
		span = 64
	}
	head, err := r.Peek(span)
	if err != nil {
		return false
	}
	for i := 0; i+4 <= len(head); i++ {
		if s := string(head[i : i+4]); s == "Xing" || s == "Info" {
			r.Discard(body)
			return true
		}
	}
	return false
}
