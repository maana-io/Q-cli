import chalk from 'chalk'
import { getGraphQLConfig, getGraphQLProjectConfig } from 'graphql-config'
import inquirer from 'inquirer'
import shell from 'shelljs'
import fs from 'fs'
import stripBom from 'strip-bom'
var path = require('path')

const prompt = inquirer.createPromptModule()

const scripts = {
  publish: __dirname + `/scripts/publish.sh`,
  deploy: __dirname + `/scripts/deploy.sh`,
  update: __dirname + `/scripts/update.sh`
}

// Total number of attempts mdeploy will try obtaining service ip address
// 10 * 12 = 120 seconds = 2 minutes
const maxRetries = 12;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const command = 'mdeploy'
// [serviceName] [servicePath] [registryPath] [versionTag] [numReplicas]
export const describe = 'Deploy your service to Kubernetes'
export const builder = {
  programatic: {
    alias: 'pr',
    describe:
      'Disable the interactive mode of the CLI to use it programatically',
    type: 'boolean',
    default: false
  },
  serviceName: {
    alias: 'name',
    describe: 'The name for the service',
    type: 'string',
    default: ''
  },
  servicePath: {
    alias: 'path',
    describe:
      'The path to the folder containing the Dockerfile for the service',
    type: 'string',
    default: ''
  },
  registryPath: {
    alias: 'registry',
    describe: 'The hostname to a container registry',
    type: 'string',
    default: ''
  },
  versionTag: {
    alias: 'tag',
    describe: 'The version tag for the service',
    type: 'string',
    default: ''
  },
  numReplicas: {
    alias: 'replicas',
    describe: 'The number of pods for the service',
    type: 'number',
    default: 0
  },
  port: {
    name: 'port',
    message: 'What is the port your application is running on?',
    default: 8050,
    type: 'input'
  }
}

const azureLogin = async () => {
  console.log(chalk.blueBright('Please log in to your Azure account:'))

  const credentials = await prompt([
    {
      message: 'Username:',
      type: 'input',
      name: 'username'
    },
    {
      message: 'Password:',
      type: 'password',
      name: 'password'
    }
  ])

  const { username, password } = credentials

  shell.exec(`az login -u ${username} -p ${password}`)

  console.log(chalk.green('Success!'))
}

const azureDeploy = async () => {
  const resourceGroupsResponse = shell.exec('az group list -o json')
  const resourceGroups = JSON.parse(resourceGroupsResponse.stdout)

  const resourceGroupQuestion = [
    {
      message: 'Which resource group would you like to use?',
      name: 'resourceGroup',
      type: 'list',
      choices: resourceGroups
    }
  ]

  const resourceGroupAnswer = await prompt(resourceGroupQuestion)
  const { resourceGroup } = resourceGroupAnswer

  const aksServicesRespinse = shell.exec(
    `az aks list --resource-group ${resourceGroup}`
  )
  const aksServices = JSON.parse(aksServicesRespinse.stdout)

  const aksServiceQuestion = [
    {
      message: 'Which AKS cluster would you like to use?',
      name: 'aksService',
      type: 'list',
      choices: aksServices
    }
  ]

  const aksServiceAnswer = await prompt(aksServiceQuestion)
  const { aksService } = aksServiceAnswer

  console.log(chalk.blueBright('Getting AKS credentials'))
  shell.exec(
    `az aks get-credentials --resource-group ${resourceGroup} --name ${aksService} --override`
  )
  console.log(chalk.green('Authenticated successfully with AKS'))

  const spacesResponse = shell.exec('azds space list -o json')
  const devSpacesNames = JSON.parse(spacesResponse.stdout).map(x => x.path)

  const devSpaceAnswer = await prompt([
    {
      message: 'Which Dev Space would you like to use?',
      name: 'devSpace',
      type: 'list',
      choices: devSpacesNames
    }
  ])
  const { devSpace } = devSpaceAnswer

  console.log(
    chalk.blueBright(`Selecting Dev Space `),
    chalk.greenBright(devSpace)
  )
  shell.exec(`azds space select -n ${devSpace} -y`)
  console.log(chalk.green('Dev space selected'))

  console.log(chalk.blueBright(`Preparing`))
  shell.exec('azds prep')

  console.log(chalk.blueBright(`Deploying`))
  shell.exec('azds up')

  console.log(chalk.bgGreen(`Deployment complete`))
}

const printServiceAddresses = async (
  serviceName,
  port,
  attempt = 0
) => {
  const result = shell.exec(`kubectl get service "${serviceName}" -o 'jsonpath={.status.loadBalancer.ingress[].ip}'`, { silent: true })
  if(result.code != 0) {
    console.log(`${chalk.red('Something went wrong, aborting')}`)
    process.exit(-1);
  }

  if(result.stdout === '') {
    if(attempt > maxRetries) {
      console.log(`${chalk.red('Something went wrong, aborting')}`)
      process.exit(-1);
    } else {
      await sleep(10000) // Sleep for 10 seconds before next attempt
      await printServiceAddresses(serviceName, port, attempt + 1)
    }
  } else {
    console.log(`The external IP address for ${chalk.blue(serviceName)} is\n\t${chalk.green(result.stdout)}\n`)
    console.log(`The URL for your GraphQL endpoint is\n\t${chalk.green('http://' + result.stdout + ':' + port + '/graphql')}\n`)
  }
}

const buildAndPublishImage = async (
  serviceName,
  servicePath,
  registryPath,
  versionTag
) => {
  const tag = `${registryPath}/${serviceName}:${versionTag}`

  console.log(chalk.green(`Building ${serviceName}`))
  let result = shell.exec(`docker build ${servicePath} -t ${tag}`)
  if(result.code != 0) {
    console.log(`${chalk.red('Something went wrong, aborting')}`)
    process.exit(-1);
  }
  console.log(chalk.green(`Docker image build, publishing`))

  result = shell.exec(`docker push ${tag}`)
  if(result.code != 0) {
    console.log(`${chalk.red('Something went wrong, aborting')}`)
    process.exit(-1);
  }
}

const registryDeploy = async (
  serviceName,
  servicePath,
  registryPath,
  versionTag,
  numReplicas,
  port
) => {
  const templatePath = __dirname + '/scripts/deployment-service.yaml'
  const template = fs.readFileSync(templatePath, { encoding: "utf8" })

  const manifest = template
    .replace(/\{\{SERVICE_NAME\}\}/g, serviceName)
    .replace(/\{\{IMAGE\}\}/g, `${registryPath}/${serviceName}:${versionTag}`)
    .replace(/\{\{PORT\}\}/g, port)
    .replace(/\{\{REPLICAS\}\}/g, numReplicas)

  const manifestPath = `${servicePath}/${serviceName}.yaml`

  fs.writeFileSync(manifestPath, manifest, { encoding: 'utf8', flag: 'w' })

  const resolvedPath = fs.realpathSync(manifestPath)

  console.log(`K8s deployment manifest file is saved in ${chalk.green(resolvedPath)}.`)
  console.log('This file can be used to reproduce deployment on other K8s clusters by running:')
  console.log(chalk.green(`\n\tkubectl apply -f ${resolvedPath}\n`));

  await buildAndPublishImage(
    serviceName,
    servicePath,
    registryPath,
    versionTag
  )

  let result = shell.exec(`kubectl apply -f ${manifestPath}`)
  if(result.code != 0) {
    console.log(`${chalk.red('Something went wrong, aborting')}`)
    process.exit(-1);
  }

  printServiceAddresses(serviceName, port, 0);
}

export const handler = async (context, argv) => {
  if (argv.programatic) {
    const {
      serviceName,
      servicePath,
      registryPath,
      versionTag,
      numReplicas,
      port
    } = argv

    await registryDeploy(
      serviceName,
      servicePath,
      registryPath,
      versionTag,
      numReplicas,
      port
    )
  } else {
    const questions = [
      {
        name: 'targetPlatform',
        message: 'What is target platform you are deplying to',
        type: 'list',
        choices: [
          { name: 'Private Docker Registry', value: 'registry' },
          { name: 'Azure AKS (Must have Azure CLI installed)', value: 'aks' }
        ]
      }
    ]
    const answers = await prompt(questions)
    switch (answers.targetPlatform) {
      case 'aks':
        const homedir = require('os').homedir()
        const credentials = await fs.readFileSync(
          homedir + '/.azure/azureProfile.json',
          'utf8'
        )
        const { subscriptions } = JSON.parse(stripBom(credentials))

        if (subscriptions.length === 0) {
          await azureLogin()
        }

        await azureDeploy()
        console.log(chalk.green('Deployment on Azure AKS is Complete'))
        break
      case 'registry':
        const serviceNameShell = path.basename(process.cwd())

        const registryQuestions = [
          {
            name: 'serviceName',
            message: 'What is the service name?',
            default: serviceNameShell,
            type: 'string'
          },
          {
            name: 'servicePath',
            message:
              'What is the path to the folder containing your Dockerfile?',
            default: process.cwd() + '/service',
            type: 'string'
          },
          {
            name: 'registryPath',
            message: 'What is hostname for your container registry?',
            default: 'services.azurecr.io',
            type: 'string'
          },
          {
            name: 'versionTag',
            message: 'What version tag you would like to use?',
            default: 'v1',
            type: 'string'
          },
          {
            name: 'numReplicas',
            message: 'How many pods would you like to spin up?',
            default: 1,
            type: 'input'
          },
          {
            name: 'port',
            message: 'What is the port your application is running on?',
            default: 8050,
            type: 'input'
          }
        ]

        const registryOptions = await prompt(registryQuestions)

        const {
          serviceName,
          servicePath,
          registryPath,
          versionTag,
          numReplicas,
          port
        } = registryOptions

        const finalConfirmation = await prompt({
          message:
            `Please confirm the following deployment plan:\n` +
            `Deploying the service ${chalk.green(
              serviceName + ':' + versionTag
            )}\n` +
            `Located in ${chalk.green(servicePath)}\n` +
            `Publishing to ${chalk.green(registryPath)}\n` +
            `Number Of Pods: ${chalk.green(numReplicas)}\n` +
            `Exposing port ${chalk.green(port)}\n` +
            `Confirm?`,
          name: 'confirm',
          type: 'confirm'
        })

        if (finalConfirmation.confirm) {
          await registryDeploy(
            serviceName,
            servicePath,
            registryPath,
            versionTag,
            numReplicas,
            port
          )
        } else {
          console.log('Exiting...')
        }

        break
    }
  }
}
