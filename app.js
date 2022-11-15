const axios = require('axios');
const inquirer = require('inquirer');
const { Console, dir } = require('console');
const fs = require('fs');
const { Int32, ConnectionCheckOutStartedEvent } = require('mongodb');
let mongoose = require('mongoose')
let parcelSchema = new mongoose.Schema({ coords: String, id: String, dirty: Boolean })
const Parcel = mongoose.model('Parcel', parcelSchema)
const dotenv = require("dotenv");
const { reduce } = require('async');
const { join } = require('path');
const { json } = require('express');
const { isNumberObject } = require('util/types');
dotenv.config()

var geoJsonFile = fs.createWriteStream('geo.json')
var estatesJsonFile = fs.createWriteStream('estates.json')
var coordsStream = fs.createWriteStream('coords.txt')
var coordsRawStream = fs.createWriteStream('raw_coords.txt')
var logger = fs.createWriteStream('logs.txt', {flags: 'a' /*append*/})
const args = process.argv.slice(2)

const choices = [
  'Full run', 
  'Mark all as clean',
  'Round coords for unity', 
  // 'Delete database',
  'Estate tests'];

inquirer
  .prompt([
    {
      type: 'list',
      name: 'mode',
      message: 'What do you want to do?',
      choices: choices,
    },
  ])
  .then(answers => {
    switch (answers.mode) {
      case choices[0]:
        run().catch(error => logMessage(error.stack))
        break;
      case choices[1]:
        markAllAsClean().catch(error => logMessage(error.stack))
        break;
      case choices[2]:
        roundCoordsForUnity().catch(error => logMessage(error.stack))
        break;
      // case choices[3]:
      //   deleteDatabase().catch(error => logMessage(error.stack))
      //   break;
      case choices[3]:
        getEstates().catch(error => logMessage(error.stack))
        break;
      default:
        logMessage('Option not found');
        process.exit();
    }
  });

async function run() {
  logMessage("Full run started")
  await connectToDB()

  logMessage("Looking for dirty parcels in db...")
  let dbParcels = await getDirtyParcels()
  logMessage(`Parcels found ${dbParcels.length}`)

  var allCoords = generateCoordsArray()

  // Check if need to apply filter to allCoords array
  if (dbParcels.length > 0) {
    logMessage(`Filtering array (${allCoords.length}) with db parcels...`)
    allCoords = filterParcelsWithDB(allCoords, dbParcels)
    logMessage(`Total parcels after filter: ${allCoords.length}`)
  }

  if (args.includes('resume')) {
    let resumeAtIndex = allCoords.indexOf(args[1])
    logMessage(`Found resume coord at index: ${resumeAtIndex}`)
    logMessage(`AllCoords: ${allCoords.length}`)
    if (resumeAtIndex > 0) {
      var removed = allCoords.splice(0, resumeAtIndex)
      logMessage(`Resume at: ${resumeAtIndex}, allCoords: ${allCoords.length}`)
    } 
  }

  // Start making requests
  let result = await manageCoordsRequests(allCoords)
  logMessage(result)

  // Make coords.txt in desktop for Unity
  // await roundCoordsForUnity()

  logMessage("Full run finished")
  logger.end()
}

// FUNCTIONS
function generateCoordsArray() {
  let maxX = 150
  let maxY = 150
  var allCoords = []
  
  for (let xIndex = -maxX; xIndex <= maxX; xIndex++) {
    for (let yIndex = -maxY; yIndex <= maxY; yIndex++) {
      allCoords.push(`${xIndex},${yIndex}`)
    }
  }
  return allCoords
}

function filterParcelsWithDB(allCoords, dbParcels) {
  let dbCoords = dbParcels.map(parcel => parcel.coords)
  return allCoords.filter(el => !dbCoords.includes(el))
}

async function manageCoordsRequests(allCoords) {
  // allCoords.length = 200 //Get N elements from array for testing purpose only
  while (allCoords.length > 0) {
    logMessage(`Coords remaining: ${allCoords.length}`)
    let targetCoords = allCoords[0]
    let parcel = await getContentFromCoords(targetCoords)
    for await (const coord of parcel.pointers) {
      await compareParcelAndSave(coord, parcel.id)
    }
    allCoords = allCoords.filter(el => !parcel.pointers.includes(el))
  }
  return "FINISHED REQUESTING PARCELS"
}

async function getContentFromCoords(coords) {
  try {
    logMessage(`Requesting: ${coords}`)
      const response = await axios.get(`https://peer.decentraland.org/content/entities/scene?pointer=${coords}`)
      if (response.data.length == 0) {
        logMessage(`Id for ${coords}: Empty`)
        return {"id": "", "pointers": [coords]}
      }
      let parcel = response.data[0]
      if ('id' in parcel && 'pointers' in parcel) {
        logMessage(`Id for ${coords}: ${parcel.id} shared with ${parcel.pointers.length - 1} other coords.`)
        return {"id": parcel.id, "pointers": parcel.pointers }
      }
      logMessage(`Response without required fields: ${response}`)
  } catch(err) {
      logMessage(err)
  }
}

async function compareParcelAndSave(coords, id) {
  let parcel = await Parcel.findOne({ coords: `${coords}` }).exec();
  if ((parcel != null) && (parcel.dirty == true || parcel.id == id)) {
    logMessage(`Coords ${coords} already saved/dirty`)  
    return
  }
  createAndSaveParcel(coords, id)
}

// Database methods
async function connectToDB() {
  logMessage("Connecting to db...")
  await mongoose.connect(`mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@mapper.odqgd.mongodb.net/myFirstDatabase?retryWrites=true&w=majority`)
  logMessage("Db connected.")
}

function createAndSaveParcel(coords, id) {
  let newParcelData = { coords: coords, id: id, dirty: true }
  let oldParcelData = Parcel.findOneAndUpdate({ coords: `${coords}` }, newParcelData, {upsert: true}).exec()
  logMessage(`Coords ${coords} saved. Old id: ${oldParcelData.id} - New id: ${newParcelData.id}`)
  // logCoords(coords, id)
}

async function getDirtyParcels() { 
  return await Parcel.find({ dirty: true }).exec()
}

async function markAllAsClean() {
  await connectToDB()
  let parcels = await Parcel.updateMany(null, { dirty: false })
  logMessage(`All cleaned - ${parcels.acknowledged} ${(await getDirtyParcels()).length}`)
}

async function deleteDatabase() {
  await connectToDB()
  await Parcel.deleteMany()
  logMessage("All deleted")
}

// Generating results for Unity renderer in coords.txt
const unitySize = 5
const roundForUnitySize = x => Math.round(x/unitySize)*unitySize

async function roundCoordsForUnity() {
  logMessage("Rounding coords for unity")
  await connectToDB()
  let dirtyParcels = await getDirtyParcels()

  console.log(`Dirty parcels found: ${dirtyParcels.length}`)
  let rawCoords = dirtyParcels.slice()
  generateGeoJson(rawCoords)
  var groupedRawCoords = []

  while (rawCoords.length > 0) {
    var coords = []
    let parcel = rawCoords[0]
    // console.log(`Current coords: ${parcel.coords} - id: ${parcel.id}`)
    if (parcel.id == '') {
      coords = [parcel.coords]
    } else {
      let estateCoords = rawCoords.filter(el => el.id == parcel.id)
      // console.log(`estateCoords ${estateCoords.length}`)
      let mappedCoords = estateCoords.map(el => el.coords)
      // console.log(`mappedCoords ${mappedCoords.length}`)
      coords = mappedCoords
    }
    groupedRawCoords.push(coords)
    rawCoords = rawCoords.filter(el => !coords.includes(el.coords))
  }

  let roundedCoords = []
  dirtyParcels.map(el => {
    let intCoords = el.coords.split(',')
    if (intCoords.length != 2) { return }
    let x = roundForUnitySize(parseInt(intCoords[0]))
    let y = roundForUnitySize(parseInt(intCoords[1]))
    if (Math.abs(x) > 150 || Math.abs(y) > 150) { return }
    let rounded = `${x},${y}`
    el.coords = rounded
    roundedCoords.push(el)
  })
  dirtyParcels = roundedCoords

  var groupedCoords = []
  while (dirtyParcels.length > 0) {
    var coords = []
    let parcel = dirtyParcels[0]
    // console.log(`Current coords: ${parcel.coords} - id: ${parcel.id}`)
    if (parcel.id == '') {
      coords = [parcel.coords]
    } else {
      let estateCoords = dirtyParcels.filter(el => el.id == parcel.id)
      // console.log(`estateCoords ${estateCoords.length}`)
      let mappedCoords = estateCoords.map(el => el.coords)
      // console.log(`mappedCoords ${mappedCoords.length}`)
      coords = mappedCoords
    }
    groupedCoords.push(coords)
    dirtyParcels = dirtyParcels.filter(el => !coords.includes(el.coords))
  }

  let sets = groupedCoords.map(el => {
    return new Set(el)
  })

  let rawSets = groupedRawCoords.map(el => {
    return new Set(el)
  })
  // console.log(rawSets)
  let mappedRaw = rawSets.map(el => Array.from(el).join(';'))
  let allRaw = mappedRaw.join('\n')
  coordsRawStream.write(allRaw)
  coordsRawStream.end()

  let mapped = sets.map(el => Array.from(el).join(';'))
  //console.log(mapped)
  let all = mapped.join('\n')
  coordsStream.write(all)
  coordsStream.end()
  process.exit()
}

const parcelSize = 40
const mapSize = 152

function generateGeoJson(coords) {
  // console.log(allRaw)
  let coordsJson = []
  Array.from(coords).forEach(el => {
    // console.log(el)
    let intCoords = el.coords.split(',')
    var x = parseInt(intCoords[0]) + mapSize
    var y = parseInt(intCoords[1]) + mapSize
    x = x * parcelSize
    y = y * parcelSize
    coordsJson.push({"type":"Feature","geometry": {"type":"Polygon","coordinates":[[[x,y],[x,y+parcelSize],[x+parcelSize,y+parcelSize],[x+parcelSize,y],[x,y]]]}})
  })

  let geoJson = JSON.stringify({"type":"FeatureCollection","features":coordsJson})

  geoJsonFile.write(geoJson)
  geoJsonFile.end()
}

// Logger functions
function logMessage(message) {
  let fullMessage = `[${getCurrentDateAndTime()}]: ${message}`
  console.log(fullMessage)
  logger.write(fullMessage + "\n")
}

function getCurrentDateAndTime() {
  return `${new Date().toString()}`
}


  //////////////////////////////////////////////////////////
 ////////////////////  ESTATES START  /////////////////////
//////////////////////////////////////////////////////////
async function getEstates() {
  try {
    const response = await axios.get(`https://nft-api.decentraland.org/v1/nfts?first=1000&skip=0&sortBy=newest&category=estate`)
    let estates = []
    response.data.data.forEach(estate => {
      estates.push(drawEstate(estate.nft.data.estate.parcels))
    })

    // let mocked = mockEstate()
    // estates.push(drawEstate(mocked.nft.data.estate.parcels))

    // console.log("Drawing RESULT", estates)
    console.log("Parcels length:", estates.length)
    generateEstatesJSON(estates)
    process.exit()
  } catch(err) {
    logMessage(err)
    throw err
  }
}

function drawEstate(estate) {
  console.log("Drawing estate:", estate)
  let estateData = estate.map(el => {
    return {coord: el, points: estateToPoints(el)}
  })

  var first = estateData.splice(0, 1)[0]
  console.log("first", first)
  var coordsApplied = [first.coord]
  console.log("coordsApplied", coordsApplied)
  var drawing = first.points
  while (estateData.length > 0) {
    let adjacentData = getAdjacentCoord(coordsApplied, estateData)
    let adjacent = adjacentData[0]
    estateData.splice(estateData.indexOf(adjacent), 1)
    let indices = []
    console.log("adjacent found", adjacent)
    for (var i = adjacent.points.length - 1; i >= 0; i--) {
      var currentAdjacent = adjacent.points[i]
      for (var j = drawing.length - 1; j >= 0; j--) {
        var currentDrawing = drawing[j]
        if ((currentAdjacent.x === currentDrawing.x) && (currentAdjacent.y === currentDrawing.y)) {
          console.log("i", i, adjacent.points.length, "j", j, drawing.length)
          indices.push(j)
          console.log("Removing from draw", currentAdjacent)
          adjacent.points.splice(i, 1)
          drawing.splice(j, 1)
        }
      }
    }

    if (indices.length === 0) {
      console.log("INDICES LENGHT 0")
      indices = [getIndexFor(adjacentData, drawing)]
    }

    console.log("POINTS TO ADD", adjacent, "to", drawing)
    drawing.splice(indices[indices.length - 1], 0, ...adjacent.points)
    coordsApplied.unshift(adjacent.coord)
    console.log("DRAWING PROGRESS", drawing)
  }
  drawing.push(drawing[0])
  console.log("DRAWING FINISHED", drawing)
  return drawing
}

function getAdjacentCoord(coordsApplied, estate) {  
  for(const current of coordsApplied) {
    for(const el of estate) {
      if ((el.coord.x === current.x - 1) && (el.coord.y === current.y)) {
        var result = el
        result.points = rotate(el.points, 3)
        console.log("ROTATING POINTS BY 3", current)
        return [result, current]
      }
    }
  }

  for(const current of coordsApplied) {
    for(const el of estate) {
      if ((el.coord.x === current.x) && (el.coord.y === current.y + 1)) {
        console.log("NO ROTATING ADJACENT IS UP")
        return [el, current]
      }
    }
  }

  for(const current of coordsApplied) {
    for(const el of estate) {
      if ((el.coord.x === current.x + 1) && (el.coord.y === current.y)) {
        var result = el
        result.points = rotate(el.points, 1)
        console.log("ROTATING POINTS BY 1", current)
        return [result, current]
      }
    }
  }

  for(const current of coordsApplied) {
    for(const el of estate) {
      if ((el.coord.x === current.x) && (el.coord.y === current.y - 1)) {
        var result = el
        result.points = rotate(el.points, 2)
        console.log("ROTATING POINTS BY 2", current)
        return [result, current]
      }
    }
  }
    
  console.log("NO ADJACENT FOUND IN", estate, "applied", coords)
  process.exit()
}

function getIndexFor(adjacent, drawing) {
  console.log("adjacent", adjacent)
  let next = adjacent[0]
  let startingEstate = adjacent[1]
  console.log("next", next, "startingPoint", startingEstate)
  let startingPoints = estateToPoints(startingEstate)
  console.log("startingPoints", startingPoints)
  let linePoints = []
  for(const startingPoint of startingPoints) {
    for(const nextPoint of next.points) {
      if (startingPoint.x === nextPoint.x && startingPoint.y === nextPoint.y) {
        linePoints.push(nextPoint)
      }
    }
  }
  var isHorizontal = linePoints[0].x === linePoints[1].x
  if (isHorizontal) {
    linePoints.sort(function(a, b){return a.x-b.x});
  } else {
    linePoints.sort(function(a, b){return a.y-b.y});
  }
  return getClosestPointIndex(linePoints[0], drawing, isHorizontal) + 1
}

function estateToPoints(coords /* {"x":0, "y":0} */) {
  let x = coords.x + mapSize
  let y = coords.y + mapSize
  x = x * parcelSize
  y = y * parcelSize
  return [{"x": x,"y": y},{"x": x,"y": y+parcelSize},{"x": x+parcelSize,"y": y+parcelSize},{"x": x+parcelSize,"y": y}]
}

function generateEstatesJSON(estates) {
  let polygons = estates.map(estate => {
    return generatePolygonJson(estate)
  })
  
  let estatesJson = JSON.stringify({"type":"FeatureCollection", "crs": {"type": "name", "properties": {"name": "ESTATES"}}, "features":polygons})
  estatesJsonFile.write(estatesJson)
  estatesJsonFile.end()
  console.log("Estates json created")
}

function generatePolygonJson(estate) {
  var result = estate.map(point => {
    return [point.x, point.y]
  })
  return {"type":"Feature","geometry": {"type":"Polygon","coordinates":[result]}}
}

function getClosestPointIndex(point, drawing, isHorizontal) {
  console.log("getClosestPoint", point, drawing, isHorizontal)
  let sameAxisPoints = drawing.filter(el => isHorizontal ? (el.x == point.x) : (el.y == point.y))//.map(el => isHorizontal ? el.y : el.x)
  let reduced = sameAxisPoints.reduce((previous, current) => {
    return (current > previous && current < point) ? current : previous
  })

  console.log(reduced)
  console.log(drawing.indexOf(reduced))
}
/////////////////////  ESTATES END  /////////////////////

function rotate(arr, count) {
  count -= arr.length * Math.floor(count / arr.length);
  arr.push.apply(arr, arr.splice(0, count));
  return arr;
}
// function mockEstate() {
//   // let data = [{"x": -71,"y": 125},{"x": -71,"y": 126},{"x": -71,"y": 127},{"x": -71,"y": 129},{"x": -70,"y": 125},{"x": -70,"y": 126},{"x": -70,"y": 127},{"x": -70,"y": 128},{"x": -70,"y": 129}]
//   let  data = [{"x": 0,"y": 0}, {"x": 1,"y": 0}, {"x": 2,"y": 0}, {"x": 0,"y": 1}, {"x": 2,"y": 1}, {"x": 0,"y": 2}, {"x": 2,"y": 2}]
//   processEstateData(data)
// }



// function generateEstatesJSON(parcels) {

// }


function mockEstate() {
  return JSON.parse('{"nft":{"id":"0x959e104e1a4db6317fa58f8295f586e1a978c297-3847","tokenId":"3847","contractAddress":"0x959e104e1a4db6317fa58f8295f586e1a978c297","activeOrderId":"0x7068c5480f4f73895395e216ea32e45d81ae758c4e13f0db43fce0df3d2e3070","openRentalId":null,"owner":"0x3a572361910939dfc230bc010dadc9de7bd3af4b","name":"South  left gate","image":"https://api.decentraland.org/v1/estates/3847/map.png","url":"/contracts/0x959e104e1a4db6317fa58f8295f586e1a978c297/tokens/3847","data":{"estate":{"description":"South  left gate!","size":13,"parcels":[{"x":-2,"y":-150},{"x":-2,"y":-144},{"x":-2,"y":-143},{"x":-2,"y":-142},{"x":-1,"y":-150},{"x":-1,"y":-149},{"x":-1,"y":-148},{"x":-1,"y":-147},{"x":-1,"y":-146},{"x":-1,"y":-145},{"x":-1,"y":-144},{"x":-1,"y":-143},{"x":-1,"y":-142}]}},"issuedId":null,"itemId":null,"category":"estate","network":"ETHEREUM","chainId":1,"createdAt":1601652467000,"updatedAt":1663477751000,"soldAt":0},"order":{"id":"0x7068c5480f4f73895395e216ea32e45d81ae758c4e13f0db43fce0df3d2e3070","marketplaceAddress":"0x8e5660b4ab70168b5a6feea0e0315cb49c8cd539","contractAddress":"0x959e104e1a4db6317fa58f8295f586e1a978c297","tokenId":"3847","owner":"0x3a572361910939dfc230bc010dadc9de7bd3af4b","buyer":null,"price":"1755001000000000000000000","status":"open","network":"ETHEREUM","chainId":1,"expiresAt":1671667200000,"createdAt":1643357946000,"updatedAt":1643357946000},"rental":null}')
}