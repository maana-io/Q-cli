import Path from 'path'
import Zip from 'adm-zip'
import chalk from 'chalk'
import commandExists from 'command-exists'
import fs from 'fs'
import gh from 'parse-github-url'
import { padEnd } from 'lodash'
import request from 'request'
import rimraf from 'rimraf'
import { spawn } from 'cross-spawn'
import tmp from 'tmp'

// Project boilerplates
export const defaultBoilerplates = [
  {
    name: 'service-csharp',
    description: 'C# microservice (basic)',
    repo: `https://github.com/maana-io/q-template-service-csharp/tree/master`
  },
  {
    name: 'service-node-js',
    description: 'JavaScript microservice (basic)',
    repo: `https://github.com/maana-io/q-template-service-node-basic/tree/master`
  },
  {
    name: 'service-node-js-mongo',
    description: 'JavaScript microservice with support for MongoDB',
    repo: `https://github.com/maana-io/q-template-service-node-mongo/tree/master`
  },
  {
    name: 'service-typescript',
    description: 'Typescript microservice (basic)',
    repo: `https://github.com/maana-io/q-template-service-typescript-basic/tree/master`
  },
  {
    name: 'service-python-ariadne',
    description: 'Python microservice using Ariadne',
    repo: `https://github.com/maana-io/q-template-service-python-ariadne/tree/master`
  },
  {
    name: 'app-react-js',
    description: 'React (JavaScript) Knowledge Application',
    repo: `https://github.com/maana-io/q-template-app-react/tree/master`
  },
  {
    name: 'assistant-react-js-basic',
    description: 'Basic React (JavaScript) Assistant',
    repo: `https://github.com/maana-io/q-template-assistant-react/tree/master`
  },
  {
    name: 'assistant-react-js-advanced',
    description: 'Advanced React (JavaScript) Assistant',
    repo: `https://github.com/maana-io/q-template-assistant-react-advanced/tree/master`
  }
]

// Plugin boilerplate
export const command = 'mcreate [directory]'
export const describe =
  'Bootstrap a new Maana Knowledge Microservice, Bot, Assistant, or Knowledge Application'

export const builder = {
  boilerplate: {
    alias: 'b',
    describe:
      'Full URL or repo shorthand (e.g. `owner/repo`) to boilerplate GitHub repository',
    type: 'string'
  },
  'no-install': {
    describe: `Don't install project dependencies`,
    type: 'boolean',
    default: false
  }
}

//
// Internal helpers
//
const getZipInfo = boilerplate => {
  let baseUrl = boilerplate
  let branch = 'master'
  let subDir = ''

  const branchMatches = boilerplate.match(
    /^(.*)\/tree\/([a-zA-Z-_0-9]*)\/?(.*)$/
  )
  if (branchMatches) {
    baseUrl = branchMatches[1]
    branch = branchMatches[2]
    subDir = branchMatches[3]
  }

  if (subDir === undefined) {
    subDir = ''
  }

  if (!subDir.startsWith('/')) {
    subDir = '/' + subDir
  }
  if (!subDir.endsWith('/')) {
    subDir = subDir + '/'
  }

  const nameMatches = baseUrl.match(/github\.com\/(.*)\/(.*)$/)
  if (!nameMatches) return

  const repoName = nameMatches[2]

  const url = `${baseUrl}/archive/${branch}.zip`
  const path = `${repoName}-${branch}${subDir}`

  return { url, path }
}

const getGitHubUrl = boilerplate => {
  const details = gh(boilerplate)

  if (details.host && details.owner && details.repo) {
    const branch = details.branch ? `/tree/${details.branch}` : ''
    return `https://${details.host}/${details.repo}${branch}`
  }
}

const shell = command => {
  return new Promise((resolve, reject) => {
    const commandParts = command.split(' ')
    const cmd = spawn(commandParts[0], commandParts.slice(1), {
      cwd: process.cwd(),
      detached: false,
      stdio: 'inherit'
    })

    cmd.on('error', reject)
    cmd.on('close', resolve)
  })
}

//
// Exported functions
//

export const handler = async (context, argv) => {
  let { boilerplate, directory, noInstall } = argv

  if (directory && directory.match(/[A-Z]/)) {
    console.log(
      `Project/directory name cannot contain uppercase letters: ${directory}`
    )
    directory = undefined
  }

  if (!directory) {
    const { newDir } = await context.prompt({
      type: 'input',
      name: 'newDir',
      default: '.',
      message: 'Directory for new Maana project',
      validate: dir => {
        if (dir.match(/[A-Z]/)) {
          return `Project/directory name cannot contain uppercase letters: ${directory}`
        }
        return true
      }
    })

    directory = newDir
  }
  if (!directory) return

  // make sure that project directory is empty
  const projectPath = Path.resolve(directory)

  if (fs.existsSync(projectPath)) {
    const allowedFiles = ['.git', '.gitignore', '.devcontainer.json']
    const conflictingFiles = fs
      .readdirSync(projectPath)
      .filter(f => !allowedFiles.includes(f))

    if (conflictingFiles.length > 0) {
      console.log(`Directory ${chalk.cyan(projectPath)} must be empty.`)
      return
    }
  } else {
    fs.mkdirSync(projectPath)
  }

  // allow short handle boilerplate (e.g. `node-basic`)
  if (boilerplate && !boilerplate.startsWith('http')) {
    const matchedBoilerplate = defaultBoilerplates.find(
      b => b.name === boilerplate
    )
    if (matchedBoilerplate) {
      boilerplate = matchedBoilerplate.repo
    } else {
      // allow shorthand GitHub URLs (e.g. `graphcool/graphcool-server-example`)
      boilerplate = getGitHubUrl(boilerplate)
    }
  }

  // interactive selection
  if (!boilerplate) {
    const maxNameLength = defaultBoilerplates
      .map(bp => bp.name.length)
      .reduce((max, x) => Math.max(max, x), 0)
    const choices = defaultBoilerplates.map(
      bp => `${padEnd(bp.name, maxNameLength + 2)} ${bp.description}`
    )
    const { choice } = await context.prompt({
      type: 'list',
      name: 'choice',
      message: `Choose Maana boilerplate project:`,
      choices
    })

    boilerplate = defaultBoilerplates[choices.indexOf(choice)].repo
  }
  if (!boilerplate) return

  // download repo contents
  const zipInfo = getZipInfo(boilerplate)
  const downloadUrl = zipInfo.url
  const tmpFile = tmp.fileSync()

  console.log(
    `[mcreate] Downloading boilerplate from ${downloadUrl} to ${tmpFile.name}...`
  )

  await new Promise(resolve => {
    request(downloadUrl)
      .pipe(fs.createWriteStream(tmpFile.name))
      .on('close', resolve)
  })

  const zip = new Zip(tmpFile.name)
  // Recent versions of adm-zip (without critical security vulnerability) take 'basename'
  // (i.e. file name only) for every entry if maintainEntryPath is set to false.
  // To work around this, after archive is extracted, move contents of extracted entry
  // to a level above and remove it
  zip.extractEntryTo(zipInfo.path, projectPath)

  const extractedPath = Path.join(projectPath, zipInfo.path)
  const dirents = fs.readdirSync(extractedPath, { withFileTypes: true })
  dirents.forEach(entry => {
    fs.renameSync(Path.join(extractedPath, entry.name), Path.join(projectPath, entry.name))
  })
  rimraf.sync(extractedPath)  
  tmpFile.removeCallback()

  // run npm/yarn install
  if (!noInstall) {
    const subDirs = fs
      .readdirSync(projectPath)
      .map(f => Path.join(projectPath, f))
      .filter(f => fs.statSync(f).isDirectory())

    const installPaths = [projectPath, ...subDirs]
      .map(dir => Path.join(dir, 'package.json'))
      .filter(p => fs.existsSync(p))

    for (const packageJsonPath of installPaths) {
      process.chdir(Path.dirname(packageJsonPath))
      console.log(
        `[mcreate] Installing node dependencies for ${packageJsonPath}...`
      )
      if (commandExists.sync('npm')) {
        await shell('npm install')
      } else if (commandExists.sync('yarn')) {
        await shell('yarn install')
      } else {
        console.log(
          `Skipping install (no ${chalk.cyan('NPM')} or ${chalk.cyan('yarn')})`
        )
      }
    }
  }

  // change dir to projectPath for install steps
  process.chdir(projectPath)

  // run & delete setup script
  let installPath = Path.join(projectPath, 'install.js')
  if (!fs.existsSync(installPath)) {
    installPath = Path.join(projectPath, '.install')
  }

  if (fs.existsSync(installPath)) {
    console.log(`[mcreate] Running boilerplate install script... `)
    const installFunction = require(installPath)

    await installFunction({
      context,
      project: Path.basename(projectPath),
      projectDir: directory
    })

    rimraf.sync(installPath)
  }
}
