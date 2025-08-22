// server.js - Node.js Express Server
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch'); // Add this dependency

const app = express();
const PORT = 3000;

// CONFIGURE YOUR COMFYUI SETTINGS HERE
const COMFYUI_INPUT_FOLDER = 'C:/Users/Ideas/Documents/ComfyUI_windows_portable_nvidia/ComfyUI_windows_portable/ComfyUI/input'; // Windows example
// const COMFYUI_INPUT_FOLDER = '/home/user/ComfyUI/input/'; // Linux example
// const COMFYUI_INPUT_FOLDER = '/Users/username/ComfyUI/input/'; // Mac example

const COMFYUI_API_URL = 'http://127.0.0.1:8188'; // Default ComfyUI API URL
const COMFYUI_WORKFLOW_FILE = './workflow.json'; // Path to your workflow JSON file
const PROMPT_DELAY_SECONDS = 5; // Delay before triggering workflow

// FIXED FILENAMES (will overwrite each time)
const INPUT_FILENAME = 'webcam_input.jpg'; // Fixed input filename
const OUTPUT_PREFIX = 'webcam_3d_mesh'; // Fixed output prefix for 3D mesh files
const MESH_FOLDER = 'mesh'; // Folder for mesh outputs

// Load ComfyUI workflow template
let workflowTemplate = {};
try {
    if (fs.existsSync(COMFYUI_WORKFLOW_FILE)) {
        workflowTemplate = JSON.parse(fs.readFileSync(COMFYUI_WORKFLOW_FILE, 'utf8'));
        console.log('Workflow template loaded from:', COMFYUI_WORKFLOW_FILE);
    } else {
        console.log('No workflow file found. Create workflow.json for automatic prompting.');
    }
} catch (error) {
    console.error('Error loading workflow template:', error.message);
}

// Ensure the directory exists
if (!fs.existsSync(COMFYUI_INPUT_FOLDER)) {
    fs.mkdirSync(COMFYUI_INPUT_FOLDER, { recursive: true });
    console.log(`Created directory: ${COMFYUI_INPUT_FOLDER}`);
}

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Function to update workflow with fixed filenames
function updateWorkflowWithImage(workflow, imageName) {
    const updatedWorkflow = JSON.parse(JSON.stringify(workflow)); // Deep clone
    
    // Find and update LoadImage nodes
    for (const nodeId in updatedWorkflow) {
        const node = updatedWorkflow[nodeId];
        
        // Update LoadImage node
        if (node.class_type === 'LoadImage') {
            if (node.inputs && node.inputs.image) {
                node.inputs.image = imageName;
                console.log(`Updated LoadImage node ${nodeId} with image: ${imageName}`);
            }
        }
        
        // Update SaveImage nodes to use fixed output prefix
        if (node.class_type === 'SaveImage') {
            if (node.inputs && node.inputs.filename_prefix) {
                node.inputs.filename_prefix = OUTPUT_PREFIX;
                console.log(`Updated SaveImage node ${nodeId} with prefix: ${OUTPUT_PREFIX}`);
            }
        }
        
        // Update SaveGLB nodes (for 3D mesh output)
        if (node.class_type === 'SaveGLB') {
            if (node.inputs && node.inputs.filename_prefix) {
                node.inputs.filename_prefix = `${MESH_FOLDER}/${OUTPUT_PREFIX}`;
                console.log(`Updated SaveGLB node ${nodeId} with prefix: ${MESH_FOLDER}/${OUTPUT_PREFIX}`);
            }
        }
        
        // Check for other image input nodes
        if (node.class_type === 'LoadImageMask' || node.class_type === 'ImageInput') {
            if (node.inputs && node.inputs.image) {
                node.inputs.image = imageName;
                console.log(`Updated ${node.class_type} node ${nodeId} with image: ${imageName}`);
            }
        }
    }
    
    return updatedWorkflow;
}

// Function to queue prompt in ComfyUI
async function queueComfyUIPrompt(workflow, filename) {
    try {
        // Check if ComfyUI is running
        const healthCheck = await fetch(`${COMFYUI_API_URL}/system_stats`);
        if (!healthCheck.ok) {
            throw new Error('ComfyUI server not responding');
        }

        // Update workflow with the new image
        const updatedWorkflow = updateWorkflowWithImage(workflow, filename);
        
        // Prepare prompt data
        const promptData = {
            prompt: updatedWorkflow,
            client_id: `webcam_app_${Date.now()}`
        };

        // Queue the prompt
        const response = await fetch(`${COMFYUI_API_URL}/prompt`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(promptData)
        });

        if (!response.ok) {
            throw new Error(`ComfyUI API error: ${response.status} ${response.statusText}`);
        }

        const result = await response.json();
        console.log('ComfyUI prompt queued successfully:', result);
        
        return {
            success: true,
            prompt_id: result.prompt_id,
            number: result.number
        };

    } catch (error) {
        console.error('Error queuing ComfyUI prompt:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

// Route to save webcam frame and queue ComfyUI workflow
app.post('/save-frame', async (req, res) => {
    try {
        const { imageData } = req.body;
        
        if (!imageData) {
            return res.status(400).json({ error: 'Missing imageData' });
        }

        // Use fixed filename instead of timestamp
        const filename = INPUT_FILENAME;

        // Remove data:image/jpeg;base64, prefix
        const base64Data = imageData.replace(/^data:image\/jpeg;base64,/, '');
        
        // Convert base64 to buffer
        const buffer = Buffer.from(base64Data, 'base64');
        
        // Full path for the file
        const filePath = path.join(COMFYUI_INPUT_FOLDER, filename);
        
        // Write file to ComfyUI input folder (will overwrite existing)
        fs.writeFileSync(filePath, buffer);
        console.log(`Frame saved (overwritten): ${filePath}`);
        
        // Send immediate response
        res.json({ 
            success: true, 
            message: `Frame saved to ${filePath}`,
            filename: filename,
            path: filePath,
            comfyui_enabled: Object.keys(workflowTemplate).length > 0,
            delay_seconds: PROMPT_DELAY_SECONDS,
            overwrite_mode: true
        });

        // Queue ComfyUI workflow after delay (if workflow is loaded)
        if (Object.keys(workflowTemplate).length > 0) {
            console.log(`Waiting ${PROMPT_DELAY_SECONDS} seconds before queuing ComfyUI workflow...`);
            
            setTimeout(async () => {
                const result = await queueComfyUIPrompt(workflowTemplate, filename);
                
                if (result.success) {
                    console.log(`✅ ComfyUI workflow queued successfully for ${filename}`);
                    console.log(`   Prompt ID: ${result.prompt_id}, Queue Number: ${result.number}`);
                    console.log(`   3D Mesh output will be saved as: ${MESH_FOLDER}/${OUTPUT_PREFIX}_XXXXX.glb`);
                } else {
                    console.log(`❌ Failed to queue ComfyUI workflow: ${result.error}`);
                }
            }, PROMPT_DELAY_SECONDS * 1000);
        }
        
    } catch (error) {
        console.error('Error saving frame:', error);
        res.status(500).json({ error: 'Failed to save frame' });
    }
});

// Route to get current configuration
app.get('/config', (req, res) => {
    res.json({ 
        saveLocation: COMFYUI_INPUT_FOLDER,
        comfyuiApiUrl: COMFYUI_API_URL,
        workflowLoaded: Object.keys(workflowTemplate).length > 0,
        delaySeconds: PROMPT_DELAY_SECONDS,
        inputFilename: INPUT_FILENAME,
        outputPrefix: OUTPUT_PREFIX,
        meshFolder: MESH_FOLDER,
        workflowType: '3D Mesh Generation (Hunyuan3D)',
        overwriteMode: true,
        exists: fs.existsSync(COMFYUI_INPUT_FOLDER)
    });
});

// Route to test ComfyUI connection
app.get('/test-comfyui', async (req, res) => {
    try {
        const response = await fetch(`${COMFYUI_API_URL}/system_stats`);
        if (response.ok) {
            const stats = await response.json();
            res.json({ 
                success: true, 
                message: 'ComfyUI is running',
                stats: stats
            });
        } else {
            res.json({ 
                success: false, 
                message: `ComfyUI returned status: ${response.status}`
            });
        }
    } catch (error) {
        res.json({ 
            success: false, 
            message: `Cannot connect to ComfyUI: ${error.message}`
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Frames will be saved to: ${COMFYUI_INPUT_FOLDER}`);
    console.log(`ComfyUI API URL: ${COMFYUI_API_URL}`);
    console.log(`Workflow delay: ${PROMPT_DELAY_SECONDS} seconds`);
    console.log(`Input filename (overwrites): ${INPUT_FILENAME}`);
    console.log(`3D Mesh output prefix: ${MESH_FOLDER}/${OUTPUT_PREFIX}`);
    console.log(`Workflow type: Hunyuan3D - Image to 3D Mesh`);
    
    if (Object.keys(workflowTemplate).length === 0) {
        console.log('⚠️  No workflow loaded. Create workflow.json to enable automatic prompting.');
    } else {
        console.log('✅ Hunyuan3D workflow template loaded and ready');
    }
});