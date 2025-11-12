#!/usr/bin/env python3
"""
URL Notes Manager - FastAPI Server
Implements the API expected by note-url.js and excalidraw-whiteboard.js scripts
Stores notes as markdown files with URL as comment
Stores Excalidraw whiteboards as JSON files
"""

import os
import json
import time
from datetime import datetime
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, Dict, Any
import uvicorn

# Configuration
NOTES_DIR = os.path.expanduser("~/.urlnotes")
EXCALIDRAW_DIR = os.path.expanduser("~/.excalidraw")
PORT = 3001

# Pydantic models
class NoteRequest(BaseModel):
    note: str = ""
    url: str = ""
    timestamp: Optional[int] = None

class NoteResponse(BaseModel):
    status: str
    note: str
    url: str
    timestamp: int

class DrawingRequest(BaseModel):
    drawing: Optional[Dict[str, Any]] = None
    url: str = ""
    timestamp: Optional[int] = None

class DrawingResponse(BaseModel):
    status: str
    drawing: Optional[Dict[str, Any]] = None
    url: str = ""
    timestamp: int

class DeleteResponse(BaseModel):
    status: str
    id: str

# FastAPI app
app = FastAPI(title="URL Notes & Excalidraw Server", version="2.0.0")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Utility functions
def get_note_file_path(url_hash: str) -> str:
    """Get the file path for a note"""
    os.makedirs(NOTES_DIR, exist_ok=True)
    return os.path.join(NOTES_DIR, f"{url_hash}.md")

def get_excalidraw_file_path(url_hash: str) -> str:
    """Get the file path for an Excalidraw whiteboard"""
    os.makedirs(EXCALIDRAW_DIR, exist_ok=True)
    return os.path.join(EXCALIDRAW_DIR, f"{url_hash}.json")

def format_note_with_url_comment(note_content: str, url: str) -> str:
    """Format note with URL as markdown comment"""
    comment = f"<!-- URL: {url} -->\n"
    return comment + note_content

def extract_note_content(note_content: str) -> str:
    """Extract note content from markdown, removing URL comment if present"""
    lines = note_content.split('\n')

    # Check if first line is a URL comment
    if lines and lines[0].startswith('<!-- URL: ') and lines[0].endswith(' -->'):
        # Skip the comment line and return the rest
        return '\n'.join(lines[1:]).lstrip('\n')

    return note_content

# Notes API
@app.get("/api/notes/{url_hash}")
async def get_note(url_hash: str):
    """GET /api/notes/{urlHash} - Load a note"""
    try:
        file_path = get_note_file_path(url_hash)

        if not os.path.exists(file_path):
            # Return empty note if not found (matches JavaScript expectation)
            return {"note": ""}

        # Read the markdown file
        with open(file_path, 'r', encoding='utf-8') as f:
            note_content = f.read()

        # Extract note content (removing URL comment)
        note_text = extract_note_content(note_content)

        # Return in format expected by JavaScript
        return {"note": note_text}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Server error: {str(e)}")

@app.post("/api/notes/{url_hash}")
async def save_note(url_hash: str, request: NoteRequest):
    """POST /api/notes/{urlHash} - Save a note"""
    try:
        note_content = request.note
        url = request.url
        timestamp = request.timestamp or int(time.time() * 1000)

        # Save as markdown file with URL comment
        file_path = get_note_file_path(url_hash)
        formatted_content = format_note_with_url_comment(note_content, url)

        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(formatted_content)

        # Return success response in format expected by JavaScript
        return {
            "status": "saved",
            "note": note_content,
            "url": url,
            "timestamp": timestamp
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Server error: {str(e)}")

@app.delete("/api/notes/{url_hash}")
async def delete_note(url_hash: str):
    """DELETE /api/notes/{urlHash} - Delete a note"""
    try:
        file_path = get_note_file_path(url_hash)

        if os.path.exists(file_path):
            os.remove(file_path)

        # Return success response
        return {"status": "deleted", "id": url_hash}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Server error: {str(e)}")

# Excalidraw API
@app.get("/api/excalidraw/{url_hash}")
async def get_excalidraw(url_hash: str):
    """GET /api/excalidraw/{urlHash} - Load an Excalidraw whiteboard"""
    try:
        file_path = get_excalidraw_file_path(url_hash)

        if not os.path.exists(file_path):
            # Return empty data if not found (matches JavaScript expectation)
            return {"drawing": None}

        # Read the JSON file
        with open(file_path, 'r', encoding='utf-8') as f:
            whiteboard_data = json.load(f)

        # Return in format expected by JavaScript
        return {"drawing": whiteboard_data}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Server error: {str(e)}")

@app.post("/api/excalidraw/{url_hash}")
async def save_excalidraw(url_hash: str, request: DrawingRequest):
    """POST /api/excalidraw/{urlHash} - Save an Excalidraw whiteboard"""
    try:
        whiteboard_content = request.drawing or {}
        url = request.url
        timestamp = request.timestamp or int(time.time() * 1000)

        # Save as JSON file
        file_path = get_excalidraw_file_path(url_hash)

        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(whiteboard_content, f, indent=2, ensure_ascii=False)

        # Return success response in format expected by JavaScript
        return {
            "status": "saved",
            "drawing": whiteboard_content,
            "url": url,
            "timestamp": timestamp
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Server error: {str(e)}")

@app.delete("/api/excalidraw/{url_hash}")
async def delete_excalidraw(url_hash: str):
    """DELETE /api/excalidraw/{urlHash} - Delete an Excalidraw whiteboard"""
    try:
        file_path = get_excalidraw_file_path(url_hash)
        print(file_path)
        if os.path.exists(file_path):
            os.remove(file_path)

        # Return success response
        return {"status": "deleted", "id": url_hash}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Server error: {str(e)}")

@app.on_event("startup")
async def startup_event():
    """Create directories on startup"""
    os.makedirs(NOTES_DIR, exist_ok=True)
    os.makedirs(EXCALIDRAW_DIR, exist_ok=True)

    print(f"URL Notes & Excalidraw Server starting on port {PORT}")
    print(f"Notes will be stored in: {NOTES_DIR}")
    print(f"Excalidraw whiteboards will be stored in: {EXCALIDRAW_DIR}")
    print("API endpoints:")
    print(f"  GET    http://localhost:{PORT}/api/notes/<urlHash>")
    print(f"  POST   http://localhost:{PORT}/api/notes/<urlHash>")
    print(f"  DELETE http://localhost:{PORT}/api/notes/<urlHash>")
    print(f"  GET    http://localhost:{PORT}/api/excalidraw/<urlHash>")
    print(f"  POST   http://localhost:{PORT}/api/excalidraw/<urlHash>")
    print(f"  DELETE http://localhost:{PORT}/api/excalidraw/<urlHash>")
    print("Press Ctrl+C to stop the server")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)