import { Runtime } from 'foldkit'
import { init, Model, update, view } from './main'

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  container: document.getElementById('root')!,
})

Runtime.run(application)
